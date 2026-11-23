package system

import (
	"context"
	"errors"
	"io/fs"
	"log/slog"
	"net/http"
	"runtime"
	"sync"
	"sync/atomic"
	"time"

	"gt.plainskill.net/LibreLoom/Sol/internal/api/response"
	"gt.plainskill.net/LibreLoom/Sol/internal/database"
)

// Version information (set at build time)
var (
	// "dev" is not semver, so unstamped builds are never offered updates.
	Version   = "dev"
	BuildTime = "unknown"
	GitCommit = "unknown"
)

// HealthHandler handles health check endpoints
type HealthHandler struct {
	db        *database.DB
	startTime time.Time

	integrityMu      sync.Mutex
	integrityRunning bool
	integrityResult  map[string]any
	integrityGen     uint64
	healthWarned     atomic.Bool
}

// NewHealthHandler creates a new HealthHandler
func NewHealthHandler(db *database.DB) *HealthHandler {
	return &HealthHandler{
		db:        db,
		startTime: time.Now(),
	}
}

// HealthResponse represents the health check response
type HealthResponse struct {
	Status        string            `json:"status"`
	Timestamp     string            `json:"timestamp"`
	Uptime        string            `json:"uptime"`
	UptimeSeconds int64             `json:"uptime_seconds"`
	Checks        map[string]string `json:"checks,omitempty"`
}

// VersionResponse represents the version info response
type VersionResponse struct {
	Version   string `json:"version"`
	BuildTime string `json:"build_time"`
	GitCommit string `json:"git_commit"`
	GoVersion string `json:"go_version"`
}

// logHealthFailure writes one warning per outage; later failures go to debug
// so a persistent missing database does not flood the log.
func (h *HealthHandler) logHealthFailure(message string, err error) {
	if h.healthWarned.Swap(true) {
		slog.Debug(message, "error", err)
		return
	}
	slog.Warn(message, "error", err)
}

// databaseHealthMessage keeps filesystem paths out of the public health
// endpoints. DB.HealthCheck logs the detail once per outage; callers just
// pick the safe wording for the response.
func databaseHealthMessage(err error) string {
	if errors.Is(err, database.ErrDatabaseFileMissing) {
		return "unhealthy: the database file is missing"
	}
	if errors.Is(err, database.ErrDatabaseUnreadable) {
		return "unhealthy: could not read the database file"
	}
	return "unhealthy: could not read the database"
}

// HealthCheck handles GET /health
// Returns overall system health including all component checks
func (h *HealthHandler) HealthCheck(w http.ResponseWriter, r *http.Request) {
	checks := make(map[string]string)
	overallStatus := "healthy"

	// Check database health. These endpoints are public, so only a short
	// verdict goes out; driver paths stay in the log.
	if err := h.db.HealthCheck(); err != nil {
		h.logHealthFailure("database health check failed", err)
		checks["database"] = databaseHealthMessage(err)
		overallStatus = "unhealthy"
	} else {
		checks["database"] = "healthy"
		h.healthWarned.Store(false)
	}

	response := HealthResponse{
		Status:        overallStatus,
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
		Uptime:        time.Since(h.startTime).Round(time.Second).String(),
		UptimeSeconds: int64(time.Since(h.startTime).Seconds()),
		Checks:        checks,
	}

	status := http.StatusOK
	if overallStatus != "healthy" {
		status = http.StatusServiceUnavailable
	}

	JSON(w, status, response)
}

// ReadinessCheck handles GET /health/ready
// Returns whether the service is ready to accept traffic
func (h *HealthHandler) ReadinessCheck(w http.ResponseWriter, r *http.Request) {
	// Check if database is accessible
	if err := h.db.HealthCheck(); err != nil {
		h.logHealthFailure("database readiness check failed", err)
		JSON(w, http.StatusServiceUnavailable, HealthResponse{
			Status:    "not ready",
			Timestamp: time.Now().UTC().Format(time.RFC3339),
			Checks:    map[string]string{"database": databaseHealthMessage(err)},
		})
		return
	}
	h.healthWarned.Store(false)

	JSON(w, http.StatusOK, HealthResponse{
		Status:    "ready",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	})
}

// DatabaseIntegrity handles POST /api/v1/system/database/integrity (admin only).
// A full PRAGMA integrity_check walks every page, so it is an explicit
// diagnostic instead of part of the short-interval health probes.
func (h *HealthHandler) DatabaseIntegrity(w http.ResponseWriter, r *http.Request) {
	// A full page walk can outlive the server's 15 s write timeout, so the
	// request only starts the check. The card polls DatabaseIntegrityStatus.
	h.integrityMu.Lock()
	if h.integrityRunning {
		h.integrityMu.Unlock()
		JSON(w, http.StatusAccepted, map[string]any{"status": "running"})
		return
	}
	h.integrityRunning = true
	h.integrityResult = nil
	gen := h.integrityGen
	h.integrityMu.Unlock()

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		corrupt, err := h.db.IntegrityCheckContext(ctx)
		var result map[string]any
		if err != nil {
			// Driver errors contain paths and page numbers: log the detail and
			// tell the card which kind of failure this was, so a timeout is
			// not reported as a damaged file.
			slog.Warn("database integrity check could not run", "error", err)
			corruptResult := map[string]any{
				"status": "corrupt", "reason": "corrupt", "corrupt": true,
				"message": "Sol found a problem with the database file. Restore a database backup in Settings → Backups.",
			}
			if errors.Is(err, fs.ErrNotExist) {
				result = map[string]any{
					"status": "unavailable", "reason": "missing", "corrupt": false,
					"message": "The database file is missing. Restore a database backup in Settings → Backups.",
				}
			} else if errors.Is(err, database.ErrDatabaseCorrupt) {
				// Same shape as a completed walk that found damage.
				result = corruptResult
			} else if ctx.Err() != nil {
				result = map[string]any{
					"status": "unavailable", "reason": "timeout", "corrupt": false,
					"message": "The database check took too long. Please try again.",
				}
			} else {
				result = map[string]any{
					"status": "unavailable", "reason": "error", "corrupt": false,
					"message": "Sol couldn't check the database file right now. Please try again.",
				}
			}
		} else if corrupt {
			result = map[string]any{
				"status": "corrupt", "reason": "corrupt", "corrupt": true,
				"message": "Sol found a problem with the database file. Restore a database backup in Settings → Backups.",
			}
		} else {
			result = map[string]any{"status": "ok", "reason": "ok", "corrupt": false}
		}
		h.integrityMu.Lock()
		// A restore/reset during the walk invalidated this generation. Its
		// verdict describes the old file and must not overwrite the new run.
		if gen == h.integrityGen {
			h.integrityResult = result
			h.integrityRunning = false
		}
		h.integrityMu.Unlock()
	}()

	JSON(w, http.StatusAccepted, map[string]any{"status": "running"})
}

// InvalidateIntegrity drops a cached verdict when the database file changes.
func (h *HealthHandler) InvalidateIntegrity() {
	h.integrityMu.Lock()
	defer h.integrityMu.Unlock()
	h.integrityGen++
	h.integrityResult = nil
	h.integrityRunning = false
}

// DatabaseIntegrityStatus returns the result of the last admin integrity check.
func (h *HealthHandler) DatabaseIntegrityStatus(w http.ResponseWriter, r *http.Request) {
	h.integrityMu.Lock()
	defer h.integrityMu.Unlock()
	if h.integrityRunning {
		JSON(w, http.StatusOK, map[string]any{"status": "running"})
		return
	}
	if h.integrityResult == nil {
		JSON(w, http.StatusOK, map[string]any{"status": "idle"})
		return
	}
	JSON(w, http.StatusOK, h.integrityResult)
}

// LivenessCheck handles GET /health/live
// Returns whether the service is alive (simple ping)
func (h *HealthHandler) LivenessCheck(w http.ResponseWriter, r *http.Request) {
	JSON(w, http.StatusOK, HealthResponse{
		Status:        "alive",
		Timestamp:     time.Now().UTC().Format(time.RFC3339),
		Uptime:        time.Since(h.startTime).Round(time.Second).String(),
		UptimeSeconds: int64(time.Since(h.startTime).Seconds()),
	})
}

// Version handles GET /api/version
// Returns version and build information
func (h *HealthHandler) Version(w http.ResponseWriter, r *http.Request) {
	JSON(w, http.StatusOK, VersionResponse{
		Version:   Version,
		BuildTime: BuildTime,
		GitCommit: GitCommit,
		GoVersion: runtime.Version(),
	})
}

// JSON and JSONError are aliases to the canonical helpers in internal/api/response
// to avoid duplication. Deprecated: import response directly.
var (
	JSON      = response.JSON
	JSONError = response.JSONError
)
