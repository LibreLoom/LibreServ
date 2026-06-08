package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/response"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/connect"
)

type ConnectHandler struct {
	client  connect.Client
	checker *connect.EntitlementChecker
}

func NewConnectHandler(client connect.Client, checker *connect.EntitlementChecker) *ConnectHandler {
	return &ConnectHandler{
		client:  client,
		checker: checker,
	}
}

func (h *ConnectHandler) Status(w http.ResponseWriter, r *http.Request) {
	if h.checker == nil {
		response.JSON(w, http.StatusOK, connect.ConnectStatus{
			Connected: false,
			Services:  defaultServiceStatuses(),
		})
		return
	}
	status := h.checker.Status()
	response.JSON(w, http.StatusOK, status)
}

func (h *ConnectHandler) Activate(w http.ResponseWriter, r *http.Request) {
	var req connect.ActivationRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSONError(w, http.StatusBadRequest, "Could not read the activation token. Please check and try again.")
		return
	}
	if req.Token == "" {
		response.JSONError(w, http.StatusBadRequest, "Please enter your Connect token.")
		return
	}

	status, err := h.client.Activate(r.Context(), req.Token)
	if err != nil {
		slog.Error("connect activation failed", "error", err)
		response.JSONError(w, http.StatusBadGateway, "Could not connect to LibreServ Connect. Please check your token and try again. If the problem persists, visit connect.serv.libreloom.org.")
		return
	}

	if h.checker != nil {
		h.checker.Refresh()
	}

	slog.Info("connect activated", "plan", status.Plan)
	response.JSON(w, http.StatusOK, status)
}

func (h *ConnectHandler) Deactivate(w http.ResponseWriter, r *http.Request) {
	if err := h.client.Deactivate(r.Context()); err != nil {
		slog.Error("connect deactivation failed", "error", err)
		response.JSONError(w, http.StatusBadGateway, "Could not disconnect from LibreServ Connect. Please try again.")
		return
	}

	if h.checker != nil {
		h.checker.Refresh()
	}

	response.JSON(w, http.StatusOK, map[string]string{
		"message": "Disconnected from LibreServ Connect. Your server will continue working using your own services.",
	})
}

func (h *ConnectHandler) UpdateServices(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Service string `json:"service"`
		State   string `json:"state"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		response.JSONError(w, http.StatusBadRequest, "Could not read the request.")
		return
	}

	svcID := connect.ServiceID(req.Service)
	svcState := connect.ServiceState(req.State)

	switch svcState {
	case connect.ServiceConnected, connect.ServiceBYO, connect.ServiceDisabled:
	default:
		response.JSONError(w, http.StatusBadRequest, "Invalid service state. Use 'connected', 'byo', or 'disabled'.")
		return
	}

	status, err := h.client.Status(r.Context())
	if err != nil || status == nil {
		response.JSONError(w, http.StatusBadGateway, "Could not reach LibreServ Connect. Please try again.")
		return
	}

	_, exists := status.Services[svcID]
	if !exists {
		response.JSONError(w, http.StatusBadRequest, "Unknown service.")
		return
	}

	if svcState == connect.ServiceConnected {
		creds, provErr := h.client.Provision(r.Context(), svcID)
		if provErr != nil {
			slog.Error("connect service provisioning failed", "service", svcID, "error", provErr)
			response.JSONError(w, http.StatusBadGateway, "Could not enable this service through Connect. Please try again.")
			return
		}
		_ = creds
	}

	status.Services[svcID] = connect.ServiceStatus{
		State: svcState,
		Label: status.Services[svcID].Label,
	}

	if h.checker != nil {
		h.checker.Refresh()
	}

	response.JSON(w, http.StatusOK, map[string]interface{}{
		"service": svcID,
		"state":   svcState,
		"message": serviceToggleMessage(svcID, svcState),
	})
}

func (h *ConnectHandler) Usage(w http.ResponseWriter, r *http.Request) {
	usage, err := h.client.Usage(r.Context())
	if err != nil {
		response.JSONError(w, http.StatusBadGateway, "Could not load usage information from LibreServ Connect.")
		return
	}
	response.JSON(w, http.StatusOK, usage)
}

func (h *ConnectHandler) Info(w http.ResponseWriter, r *http.Request) {
	info, err := h.client.Info(r.Context())
	if err != nil {
		response.JSONError(w, http.StatusBadGateway, "Could not load plan information from LibreServ Connect.")
		return
	}
	response.JSON(w, http.StatusOK, info)
}

func defaultServiceStatuses() map[connect.ServiceID]connect.ServiceStatus {
	return map[connect.ServiceID]connect.ServiceStatus{
		connect.ServiceSMTP:    {State: connect.ServiceDisabled, Label: "Email / SMTP"},
		connect.ServiceDomain:  {State: connect.ServiceDisabled, Label: "Domain & DNS"},
		connect.ServiceBackup:  {State: connect.ServiceDisabled, Label: "Cloud Backup Storage"},
		connect.ServiceTunnel:  {State: connect.ServiceDisabled, Label: "Tunnel"},
		connect.ServiceAI:      {State: connect.ServiceDisabled, Label: "AI Assistant"},
		connect.ServiceSupport: {State: connect.ServiceDisabled, Label: "Human Support"},
	}
}

func serviceToggleMessage(svc connect.ServiceID, state connect.ServiceState) string {
	switch state {
	case connect.ServiceConnected:
		return "This service is now handled by LibreServ Connect."
	case connect.ServiceBYO:
		return "You can now configure your own provider for this service."
	case connect.ServiceDisabled:
		return "This service has been turned off."
	}
	return ""
}
