package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobqueue"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

// JobQueue interface for ACME operations
type JobQueue interface {
	Enqueue(jobType jobqueue.JobType, domain, email, routeID string, priority jobqueue.JobPriority) (jobqueue.JobInfo, error)
	GetJob(ctx context.Context, jobID string) (jobqueue.JobInfo, error)
	GetLatestJob(ctx context.Context, domain string, jobType jobqueue.JobType) (jobqueue.JobInfo, error)
}

// ACMEHandler handles ACME/DNS probe flows (stub for now).
type ACMEHandler struct {
	manager      *network.ACMEManager
	caddyManager *network.CaddyManager
	routeIndex   map[string]string // domain -> routeID
	appBackends  map[string]string // appID -> backend
	appManager   *apps.Manager
	db           *database.DB
	jobQueue     JobQueue
}

// NewACMEHandler wires ACME-related API handlers.
func NewACMEHandler(db *database.DB, manager *network.ACMEManager, caddyManager *network.CaddyManager, appManager *apps.Manager) *ACMEHandler {
	return &ACMEHandler{
		manager:      manager,
		caddyManager: caddyManager,
		routeIndex:   make(map[string]string),
		appBackends:  make(map[string]string),
		appManager:   appManager,
		db:           db,
	}
}

// WithJobQueue sets the job queue for the handler
func (h *ACMEHandler) WithJobQueue(queue JobQueue) *ACMEHandler {
	h.jobQueue = queue
	return h
}

// ProbeDNS handles POST /api/v1/network/acme/probe-dns { "host": "example.com" }
func (h *ACMEHandler) ProbeDNS(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Host string `json:"host"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Host == "" {
		JSONError(w, http.StatusBadRequest, "host required")
		return
	}
	res, err := network.ResolveHostname(r.Context(), body.Host, 3*time.Second)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}
	JSON(w, http.StatusOK, res)
}

// ProbePorts handles POST /api/v1/network/acme/probe-ports { "host": "example.com", "ports": [80,443] }
func (h *ACMEHandler) ProbePorts(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Host  string `json:"host"`
		Ports []int  `json:"ports"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Host == "" || len(body.Ports) == 0 {
		JSONError(w, http.StatusBadRequest, "host and ports required")
		return
	}
	results := make([]*network.ProbeResult, 0, len(body.Ports))
	for _, p := range body.Ports {
		results = append(results, network.ProbeTCP(body.Host, p, 2*time.Second))
	}
	JSON(w, http.StatusOK, map[string]any{
		"host":    body.Host,
		"results": results,
	})
}

// RequestCert handles POST /api/v1/network/acme/request { "domain": "...", "email": "..." }
// Currently a stub that validates input and returns accepted; replace with real Caddy Admin API call.
func (h *ACMEHandler) RequestCert(w http.ResponseWriter, r *http.Request) {
	var body network.ACMERequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.Domain == "" {
		JSONError(w, http.StatusBadRequest, "domain required")
		return
	}
	if h.manager == nil {
		JSONError(w, http.StatusInternalServerError, "acme manager not configured")
		return
	}
	// Allow email to be omitted for external issuance when a default is configured.
	if body.Email == "" && h.manager.ExternalEnabled() {
		if h.caddyManager != nil && h.caddyManager.Config().Email != "" {
			body.Email = h.caddyManager.Config().Email
		}
	}
	if body.Email == "" {
		JSONError(w, http.StatusBadRequest, "email required")
		return
	}
	if h.db == nil {
		JSONError(w, http.StatusInternalServerError, "database not configured")
		return
	}
	backend := h.resolveBackend(body)
	routeID := ""
	if h.caddyManager != nil {
		// Ensure a route exists for this domain (idempotent).
		route, err := h.caddyManager.AddDomainRoute(r.Context(), body.Domain, backend, "acme-auto")
		if err != nil {
			JSONError(w, http.StatusInternalServerError, "failed to add route for domain: "+err.Error())
			return
		}
		routeID = route.ID
		// Ensure config applied after route addition
		if err := h.caddyManager.ApplyConfig(); err != nil {
			JSONError(w, http.StatusInternalServerError, "failed to apply caddy config: "+err.Error())
			return
		}
	}

	// Use job queue if available, otherwise fall back to legacy behavior
	if h.jobQueue != nil {
		job, err := h.jobQueue.Enqueue(jobqueue.JobTypeIssuance, body.Domain, body.Email, routeID, jobqueue.PriorityNormal)
		if err != nil {
			JSONError(w, http.StatusInternalServerError, "failed to enqueue acme job: "+err.Error())
			return
		}

		JSON(w, http.StatusAccepted, map[string]any{
			"message":  "ACME request accepted",
			"job_id":   job.GetID(),
			"domain":   body.Domain,
			"route_id": routeID,
			"backend":  backend,
			"status":   job.GetStatus(),
		})
	} else {
		// Legacy fallback: Create job directly in database
		job, err := network.CreateACMEJob(r.Context(), h.db, body.Domain, body.Email, routeID)
		if err != nil {
			JSONError(w, http.StatusInternalServerError, "failed to create acme job: "+err.Error())
			return
		}

		// Process issuance asynchronously and persist outcome.
		go func(jobID string, req network.ACMERequest) {
			_ = network.UpdateACMEJobRunning(context.Background(), h.db, jobID)
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
			defer cancel()
			if err := h.manager.Issue(ctx, req); err != nil {
				_ = network.UpdateACMEJobFinished(context.Background(), h.db, jobID, false, err.Error())
				return
			}
			// If certs were issued externally, regenerate and reload so Caddy picks up manual tls paths.
			if h.caddyManager != nil {
				_ = h.caddyManager.ApplyConfig()
			}
			_ = network.UpdateACMEJobFinished(context.Background(), h.db, jobID, true, "")
		}(job.ID, body)

		JSON(w, http.StatusAccepted, map[string]any{
			"message":  "ACME request accepted",
			"job_id":   job.ID,
			"domain":   body.Domain,
			"route_id": routeID,
			"backend":  backend,
			"status":   job.Status,
		})
	}
}

// EnqueueIssue creates an ACME job and runs issuance asynchronously.
// This is safe to call from other handlers (e.g., auto-issuance after route creation).
func (h *ACMEHandler) EnqueueIssue(ctx context.Context, domain, email string) (string, error) {
	if h.manager == nil {
		return "", fmt.Errorf("acme manager not configured")
	}
	if h.db == nil {
		return "", fmt.Errorf("database not configured")
	}
	job, err := network.CreateACMEJob(ctx, h.db, domain, email, "")
	if err != nil {
		return "", err
	}
	go func(jobID string, req network.ACMERequest) {
		_ = network.UpdateACMEJobRunning(context.Background(), h.db, jobID)
		issueCtx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if err := h.manager.Issue(issueCtx, req); err != nil {
			_ = network.UpdateACMEJobFinished(context.Background(), h.db, jobID, false, err.Error())
			return
		}
		if h.caddyManager != nil {
			_ = h.caddyManager.ApplyConfig()
		}
		_ = network.UpdateACMEJobFinished(context.Background(), h.db, jobID, true, "")
	}(job.ID, network.ACMERequest{Domain: domain, Email: email})
	return job.ID, nil
}

// GetJob handles GET /api/v1/network/acme/jobs/{jobID}
func (h *ACMEHandler) GetJob(w http.ResponseWriter, r *http.Request) {
	if h.db == nil {
		JSONError(w, http.StatusInternalServerError, "database not configured")
		return
	}
	id := chi.URLParam(r, "jobID")
	if id == "" {
		JSONError(w, http.StatusBadRequest, "job id required")
		return
	}
	job, err := network.GetACMEJobByID(r.Context(), h.db, id)
	if err != nil {
		JSONError(w, http.StatusNotFound, err.Error())
		return
	}
	JSON(w, http.StatusOK, job)
}

// GetStatus handles GET /api/v1/network/acme/status?domain=example.com
func (h *ACMEHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	if h.db == nil {
		JSONError(w, http.StatusInternalServerError, "database not configured")
		return
	}
	domain := r.URL.Query().Get("domain")
	if domain == "" {
		JSONError(w, http.StatusBadRequest, "domain required")
		return
	}
	job, err := network.LatestACMEJobForDomain(r.Context(), h.db, domain)
	if err != nil {
		JSONError(w, http.StatusNotFound, err.Error())
		return
	}
	JSON(w, http.StatusOK, job)
}
