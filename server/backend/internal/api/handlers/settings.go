package handlers

import (
	"encoding/json"
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/logger"
)

// SettingsHandler manages simple runtime settings operations
type SettingsHandler struct{}

// NewSettingsHandler creates a handler for settings endpoints.
func NewSettingsHandler() *SettingsHandler { return &SettingsHandler{} }

// Get returns a subset of current settings
func (h *SettingsHandler) Get(w http.ResponseWriter, r *http.Request) {
	cfg := config.Get()
	if cfg == nil {
		JSONError(w, http.StatusInternalServerError, "configuration not loaded")
		return
	}

	response := map[string]interface{}{
		"backend": map[string]interface{}{
			"host": cfg.Server.Host,
			"port": cfg.Server.Port,
			"mode": cfg.Server.Mode,
		},
		"logging": map[string]interface{}{
			"level": cfg.Logging.Level,
			"path":  cfg.Logging.Path,
		},
	}

	if cfg.Network.Caddy.Mode != "" || cfg.Network.Caddy.AdminAPI != "" {
		proxyInfo := map[string]interface{}{
			"type": "caddy",
		}
		if cfg.Network.Caddy.Mode != "" {
			proxyInfo["mode"] = cfg.Network.Caddy.Mode
		}
		if cfg.Network.Caddy.AdminAPI != "" {
			proxyInfo["admin_api"] = cfg.Network.Caddy.AdminAPI
		}
		if cfg.Network.Caddy.ConfigPath != "" {
			proxyInfo["config_path"] = cfg.Network.Caddy.ConfigPath
		}
		if cfg.Network.Caddy.DefaultDomain != "" {
			proxyInfo["default_domain"] = cfg.Network.Caddy.DefaultDomain
		}
		proxyInfo["auto_https"] = cfg.Network.Caddy.AutoHTTPS
		response["proxy"] = proxyInfo
	}

	JSON(w, http.StatusOK, response)
}

// Update allows changing a small set of runtime settings (logging level only for now)
func (h *SettingsHandler) Update(w http.ResponseWriter, r *http.Request) {
	cfg := config.Get()
	if cfg == nil {
		JSONError(w, http.StatusInternalServerError, "configuration not loaded")
		return
	}

	var body struct {
		Logging struct {
			Level string `json:"level"`
		} `json:"logging"`
	}

	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if body.Logging.Level != "" {
		cfg.Logging.Level = body.Logging.Level
		// Re-init logger with new level (stdout only for now)
		logger.Init(cfg.Logging)
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"message": "settings updated",
		"logging": cfg.Logging,
	})
}
