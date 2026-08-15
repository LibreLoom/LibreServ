package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/connect"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/settings"
)

type TunnelHandler struct {
	service  *network.TunnelService
	settings *settings.Service
	connect  connect.Client
}

func NewTunnelHandler(service *network.TunnelService, settingsSvc *settings.Service, connectClient connect.Client) *TunnelHandler {
	return &TunnelHandler{service: service, settings: settingsSvc, connect: connectClient}
}

func (h *TunnelHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	status := h.service.GetStatus()
	JSON(w, http.StatusOK, status)
}

func (h *TunnelHandler) Enable(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider string `json:"provider"`
		Token    string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if req.Provider == "" || req.Token == "" {
		JSONError(w, http.StatusBadRequest, "Please provide the tunnel provider and token.")
		return
	}

	if err := h.service.Enable(network.TunnelProviderType(req.Provider), req.Token); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't enable the tunnel. Please try again, or check your tunnel settings.")
		return
	}

	if err := h.service.Start(r.Context()); err != nil {
		JSONError(w, http.StatusInternalServerError, "We turned on the tunnel but couldn't start it. Please try again, or check your tunnel settings.")
		return
	}

	if h.settings != nil {
		if err := h.settings.PersistTunnel(req.Provider, req.Token, true); err != nil {
			slog.Warn("failed to persist tunnel config to database", "error", err)
		}
	}

	JSON(w, http.StatusOK, map[string]string{"status": "enabled"})
}

func (h *TunnelHandler) Disable(w http.ResponseWriter, r *http.Request) {
	if err := h.service.Disable(); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't disable the tunnel. Please try again.")
		return
	}

	if h.settings != nil {
		provider, token := "", ""
		if cfg := config.Get(); cfg != nil {
			provider = cfg.Network.Tunnel.Provider
			token = cfg.Network.Tunnel.Token
		}
		if err := h.settings.PersistTunnel(provider, token, false); err != nil {
			slog.Warn("failed to persist tunnel disabled state to database", "error", err)
		}
	}

	JSON(w, http.StatusOK, map[string]string{"status": "disabled"})
}

// Delete disables the tunnel and deletes the device's remote Cloudflare
// tunnel (via Connect) so it stops existing in Cloudflare entirely.
// POST /api/system/tunnel/delete (admin)
func (h *TunnelHandler) Delete(w http.ResponseWriter, r *http.Request) {
	// Stop the local cloudflared process and mark the tunnel disabled.
	if err := h.service.Disable(); err != nil {
		slog.Warn("failed to stop tunnel before delete", "error", err)
	}

	if h.settings != nil {
		if err := h.settings.PersistTunnel("", "", false); err != nil {
			slog.Warn("failed to clear tunnel config in database", "error", err)
		}
	}

	// Ask Connect to delete the remote tunnel too (best-effort: if Connect
	// isn't reachable, the local delete still succeeds — Connect's own
	// re-provision path cleans up leftovers).
	if h.connect != nil {
		if err := h.connect.DeleteTunnel(r.Context()); err != nil {
			slog.Warn("failed to delete remote tunnel via Connect", "error", err)
		}
	}

	JSON(w, http.StatusOK, map[string]string{"status": "deleted"})
}
