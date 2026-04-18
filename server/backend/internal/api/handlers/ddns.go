package handlers

import (
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

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
