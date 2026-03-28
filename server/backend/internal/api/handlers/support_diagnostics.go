package handlers

import (
	"net/http"
	"syscall"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
)

// SupportDiagnosticsHandler exposes lightweight diagnostics for support purposes.
type SupportDiagnosticsHandler struct {
	auth   *auth.Service
	docker *docker.Client
}

// NewSupportDiagnosticsHandler creates a handler for diagnostics checks.
func NewSupportDiagnosticsHandler(authService *auth.Service, dockerClient *docker.Client) *SupportDiagnosticsHandler {
	return &SupportDiagnosticsHandler{
		auth:   authService,
		docker: dockerClient,
	}
}

// Get returns basic health checks for support diagnostics.
func (h *SupportDiagnosticsHandler) Get(w http.ResponseWriter, r *http.Request) {
	cfg := config.Get()
	results := map[string]interface{}{}
	healthy := true

	check := func(name string, fn func() error) {
		if err := fn(); err != nil {
			results[name] = map[string]interface{}{"status": "failed", "error": "check failed"}
			healthy = false
		} else {
			results[name] = map[string]interface{}{"status": "ok"}
		}
	}

	check("database", func() error {
		return h.auth.DBHealth()
	})
	check("docker", func() error {
		if h.docker == nil {
			return nil
		}
		return h.docker.HealthCheck()
	})
	check("data_path_writable", func() error {
		return touchPath(cfg.Apps.DataPath)
	})

	// Disk space snapshot
	var stat syscall.Statfs_t
	if cfg != nil && cfg.Apps.DataPath != "" {
		if err := syscall.Statfs(cfg.Apps.DataPath, &stat); err == nil {
			free := stat.Bavail * uint64(stat.Bsize)
			results["disk_space_bytes_free"] = free
		}
	}

	statusCode := http.StatusOK
	if !healthy {
		statusCode = http.StatusServiceUnavailable
	}

	JSON(w, statusCode, map[string]interface{}{
		"healthy": healthy,
		"checks":  results,
		"time":    time.Now().UTC(),
	})
}
