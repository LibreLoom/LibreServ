package handlers

import (
	"encoding/json"
	"net/http"
	"runtime"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// Version information (set at build time)
var (
	Version   = "0.0.1-dev"
	BuildTime = "unknown"
	GitCommit = "unknown"
)

// HealthHandler handles health check endpoints
type HealthHandler struct {
	db        *database.DB
	startTime time.Time
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
	Status    string            `json:"status"`
	Timestamp string            `json:"timestamp"`
	Uptime    string            `json:"uptime"`
	Checks    map[string]string `json:"checks,omitempty"`
}

// VersionResponse represents the version info response
type VersionResponse struct {
	Version   string `json:"version"`
	BuildTime string `json:"build_time"`
	GitCommit string `json:"git_commit"`
	GoVersion string `json:"go_version"`
}

// HealthCheck handles GET /health
// Returns overall system health including all component checks
func (h *HealthHandler) HealthCheck(w http.ResponseWriter, r *http.Request) {
	checks := make(map[string]string)
	overallStatus := "healthy"

	// Check database health
	if err := h.db.HealthCheck(); err != nil {
		checks["database"] = "unhealthy: " + err.Error()
		overallStatus = "unhealthy"
	} else {
		checks["database"] = "healthy"
	}

	response := HealthResponse{
		Status:    overallStatus,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Uptime:    time.Since(h.startTime).Round(time.Second).String(),
		Checks:    checks,
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
		JSON(w, http.StatusServiceUnavailable, HealthResponse{
			Status:    "not ready",
			Timestamp: time.Now().UTC().Format(time.RFC3339),
			Checks:    map[string]string{"database": err.Error()},
		})
		return
	}

	JSON(w, http.StatusOK, HealthResponse{
		Status:    "ready",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	})
}

// LivenessCheck handles GET /health/live
// Returns whether the service is alive (simple ping)
func (h *HealthHandler) LivenessCheck(w http.ResponseWriter, r *http.Request) {
	JSON(w, http.StatusOK, HealthResponse{
		Status:    "alive",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		Uptime:    time.Since(h.startTime).Round(time.Second).String(),
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

// JSON writes a JSON response
func JSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		// If encoding fails, try to write a simple error
		http.Error(w, `{"error": "Failed to encode response"}`, http.StatusInternalServerError)
	}
}

// JSONError writes a JSON error response
func JSONError(w http.ResponseWriter, status int, message string) {
	JSON(w, status, map[string]string{"error": message})
}
