package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/response"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/connect"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/settings"
)

type ConnectHandler struct {
	client          connect.Client
	checker         *connect.EntitlementChecker
	settingsService *settings.Service
}

func NewConnectHandler(client connect.Client, checker *connect.EntitlementChecker, settingsService *settings.Service) *ConnectHandler {
	return &ConnectHandler{
		client:          client,
		checker:         checker,
		settingsService: settingsService,
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
		response.JSONError(w, http.StatusBadRequest, "We couldn't read that request. Please try again.")
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

	_, exists := connect.DefaultServiceStates()[svcID]
	if !exists {
		response.JSONError(w, http.StatusBadRequest, "Unknown service.")
		return
	}

	if svcState == connect.ServiceConnected {
		// Enabling through Connect requires a live Connect session and successful provisioning.
		status, err := h.client.Status(r.Context())
		if err != nil || status == nil {
			response.JSONError(w, http.StatusBadGateway, "Could not reach LibreServ Connect. Please make sure you are connected and try again.")
			return
		}
		if _, ok := status.Services[svcID]; !ok {
			response.JSONError(w, http.StatusBadRequest, "Unknown service.")
			return
		}
		creds, provErr := h.client.Provision(r.Context(), svcID)
		if provErr != nil {
			slog.Error("connect service provisioning failed", "service", svcID, "error", provErr)
			response.JSONError(w, http.StatusBadGateway, "Could not enable this service through Connect. Please try again.")
			return
		}
		_ = creds
	}

	// Persist the desired state so BYOK/disabled choices survive a restart.
	if h.settingsService != nil {
		if err := h.settingsService.UpdateSettings(r.Context(), map[string]interface{}{
			"connect_services": map[string]interface{}{string(svcID): string(svcState)},
		}); err != nil {
			slog.Error("failed to persist connect service state", "service", svcID, "state", svcState, "error", err)
			response.JSONError(w, http.StatusInternalServerError, "Could not save the service state. Please try again.")
			return
		}
	} else {
		cfg := config.Get()
		if cfg != nil {
			if cfg.Connect.ServiceStates == nil {
				cfg.Connect.ServiceStates = make(map[string]string)
			}
			cfg.Connect.ServiceStates[string(svcID)] = string(svcState)
		}
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
	return connect.DefaultServiceStates()
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
