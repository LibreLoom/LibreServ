package handlers

import (
	"encoding/json"
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

type TunnelHandler struct {
	service *network.TunnelService
}

func NewTunnelHandler(service *network.TunnelService) *TunnelHandler {
	return &TunnelHandler{service: service}
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
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Provider == "" || req.Token == "" {
		JSONError(w, http.StatusBadRequest, "Provider and token are required")
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

	JSON(w, http.StatusOK, map[string]string{"status": "enabled"})
}

func (h *TunnelHandler) Disable(w http.ResponseWriter, r *http.Request) {
	if err := h.service.Disable(); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't disable the tunnel. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]string{"status": "disabled"})
}
