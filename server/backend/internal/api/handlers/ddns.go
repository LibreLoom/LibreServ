package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

type SetIntervalRequest struct {
	IntervalMinutes int `json:"interval_minutes"`
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
	Interval   int    `json:"interval_minutes"`
}

func (h *DDNSHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	lastIP, lastUpdate, lastError := h.service.Status()

	resp := DDNSStatusResponse{
		Running:   h.service.IsRunning(),
		CurrentIP: lastIP,
		Interval:  int(h.service.GetInterval().Minutes()),
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

	if err := h.service.UpdateDNS(ctx); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't update your dynamic DNS. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]string{"status": "updated"})
}

func (h *DDNSHandler) SetInterval(w http.ResponseWriter, r *http.Request) {
	var req SetIntervalRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if req.IntervalMinutes < 1 || req.IntervalMinutes > 60 {
		JSONError(w, http.StatusBadRequest, "interval must be between 1 and 60 minutes")
		return
	}

	h.service.SetInterval(time.Duration(req.IntervalMinutes) * time.Minute)
	JSON(w, http.StatusOK, map[string]int{"interval_minutes": req.IntervalMinutes})
}
