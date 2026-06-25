package handlers

import (
	"net/http"
	"syscall"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/podman"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/util"
)

// SupportDiagnosticsHandler exposes lightweight diagnostics for support purposes.
type SupportDiagnosticsHandler struct {
	auth    *auth.Service
	runtime *podman.Client
}

// NewSupportDiagnosticsHandler creates a handler for diagnostics checks.
func NewSupportDiagnosticsHandler(authService *auth.Service, runtimeClient *podman.Client) *SupportDiagnosticsHandler {
	return &SupportDiagnosticsHandler{
		auth:    authService,
		runtime: runtimeClient,
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
	check("runtime", func() error {
		if h.runtime == nil {
			return nil
		}
		return h.runtime.HealthCheck()
	})
	check("data_path_writable", func() error {
		return checkPathWritable(cfg.Apps.DataPath)
	})

	// Disk space snapshot
	var stat syscall.Statfs_t
	if cfg != nil && cfg.Apps.DataPath != "" {
		if path, err := resolveConfigPath(cfg.Apps.DataPath); err == nil {
			if err := syscall.Statfs(path, &stat); err == nil {
				free := util.SafeDiskBytes(int64(stat.Bavail), stat.Bsize)
				results["disk_space_bytes_free"] = free
			}
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
