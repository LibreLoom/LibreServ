package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

type SetIntervalRequest struct {
	IntervalSeconds int `json:"interval_seconds"`
}

type DDNSHandler struct {
	service *network.DDNSService
}

func NewDDNSHandler(service *network.DDNSService) *DDNSHandler {
	return &DDNSHandler{service: service}
}

type DDNSStatusResponse struct {
	Running    bool   `json:"running"`
	CurrentIP  string `json:"current_ip,omitempty"`
	LastUpdate string `json:"last_update,omitempty"`
	LastError  string `json:"last_error,omitempty"`
}

func (h *DDNSHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	lastIP, lastUpdate, lastError := h.service.Status()

	resp := DDNSStatusResponse{
		Running:   h.service.IsRunning(),
		CurrentIP: lastIP,
	}

	if !lastUpdate.IsZero() {
		resp.LastUpdate = lastUpdate.Format(time.RFC3339)
	}

	if lastError != nil {
		resp.LastError = lastError.Error()
	}

	JSON(w, http.StatusOK, resp)
}

func (h *DDNSHandler) ForceUpdate(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()

	if err := h.service.ForceUpdate(ctx); err != nil {
		JSONError(w, http.StatusInternalServerError, "DDNS update failed")
		return
	}

	JSON(w, http.StatusOK, map[string]string{"status": "ok", "message": "DDNS update triggered"})
}

func (h *DDNSHandler) SetInterval(w http.ResponseWriter, r *http.Request) {
	var req SetIntervalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.IntervalSeconds < 60 {
		JSONError(w, http.StatusBadRequest, "interval must be at least 60 seconds")
		return
	}

	h.service.SetInterval(time.Duration(req.IntervalSeconds) * time.Second)

	JSON(w, http.StatusOK, map[string]interface{}{
		"status":           "ok",
		"interval_seconds": req.IntervalSeconds,
	})
}
