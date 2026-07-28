package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/google/uuid"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/response"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/connect"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/settings"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
)

type ConnectHandler struct {
	client          connect.Client
	checker         *connect.EntitlementChecker
	settingsService *settings.Service
	caddyManager    *network.CaddyManager
	backupService   *storage.BackupService
	tunnelService   *network.TunnelService
}

func NewConnectHandler(client connect.Client, checker *connect.EntitlementChecker, settingsService *settings.Service, caddyManager *network.CaddyManager, backupService *storage.BackupService, tunnelService *network.TunnelService) *ConnectHandler {
	return &ConnectHandler{
		client:          client,
		checker:         checker,
		settingsService: settingsService,
		caddyManager:    caddyManager,
		backupService:   backupService,
		tunnelService:   tunnelService,
	}
}

// smtpValidator is swapped out in tests to avoid real network calls.
var smtpValidator = email.TestSMTP

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
	if req.LicenseKey == "" {
		response.JSONError(w, http.StatusBadRequest, "Please enter your Connect license key.")
		return
	}

	status, err := h.client.Activate(r.Context(), req.LicenseKey)
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

		// Apply the provisioned credentials to the local server before recording the
		// service as connected. If this fails, we keep the previous state so the user
		// can retry without ending up with a half-configured service.
		if err := h.applyCredentials(r.Context(), svcID, creds); err != nil {
			slog.Error("failed to apply connect credentials", "service", svcID, "error", err)
			response.JSONError(w, http.StatusBadGateway, fmt.Sprintf("We couldn't apply the Connect settings for %s to your server. %v", svcID, err))
			return
		}
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

func (h *ConnectHandler) applyCredentials(ctx context.Context, svcID connect.ServiceID, creds *connect.ProvisionedCredentials) error {
	if h.settingsService == nil {
		return fmt.Errorf("Settings service is not available.")
	}

	switch svcID {
	case connect.ServiceSMTP:
		if creds.SMTP == nil {
			return fmt.Errorf("Connect did not send any email credentials.")
		}
		if smtpValidator != nil {
			cfg := config.SMTPConfig{
				Host:     creds.SMTP.Host,
				Port:     creds.SMTP.Port,
				Username: creds.SMTP.Username,
				Password: creds.SMTP.Password,
				From:     creds.SMTP.From,
				UseTLS:   creds.SMTP.UseTLS,
			}
			if err := smtpValidator(cfg); err != nil {
				return fmt.Errorf("Could not connect to your email provider. Check that the server address and port are correct.")
			}
		}
		return h.settingsService.UpdateSettings(ctx, map[string]interface{}{
			"smtp": map[string]interface{}{
				"host":     creds.SMTP.Host,
				"port":     creds.SMTP.Port,
				"username": creds.SMTP.Username,
				"password": creds.SMTP.Password,
				"from":     creds.SMTP.From,
				"use_tls":  creds.SMTP.UseTLS,
			},
		})

	case connect.ServiceDomain:
		if creds.Domain == nil {
			return fmt.Errorf("Connect did not send any domain credentials.")
		}
		domain := creds.Domain.Domain
		if domain == "" {
			return fmt.Errorf("Connect did not send a domain name.")
		}
		if err := validateDomain(domain); err != nil {
			return fmt.Errorf("The domain name provided by Connect isn't valid.")
		}
		autoHTTPS := creds.Domain.AutoHTTPS
		if err := h.settingsService.UpdateSettings(ctx, map[string]interface{}{
			"proxy": map[string]interface{}{
				"default_domain": domain,
				"auto_https":     autoHTTPS,
			},
		}); err != nil {
			return err
		}
		if h.caddyManager != nil {
			if err := h.caddyManager.UpdateDefaults(domain, "", autoHTTPS); err != nil {
				return fmt.Errorf("Could not apply the domain to your web server.")
			}
		}
		return nil

	case connect.ServiceBackup:
		if creds.Backup == nil {
			return fmt.Errorf("Connect did not send any backup credentials.")
		}
		if h.backupService == nil {
			return fmt.Errorf("Backup service is not available.")
		}
		if ok, err := h.backupService.ProvisionRestic(); err != nil || !ok {
			return fmt.Errorf("Could not set up the backup tool.")
		}
		envJSON, err := json.Marshal(creds.Backup.Env)
		if err != nil {
			return fmt.Errorf("Could not prepare the backup credentials.")
		}
		now := time.Now()
		repo := &storage.BackupRepository{
			ID:          uuid.New().String(),
			RepoType:    creds.Backup.RepoType,
			RepoPath:    creds.Backup.RepoPath,
			Password:    creds.Backup.Password,
			Credentials: string(envJSON),
			IsSystem:    false,
			CreatedAt:   now,
			UpdatedAt:   now,
		}
		if err := h.backupService.CreateRepository(ctx, repo); err != nil {
			return fmt.Errorf("Could not save the backup repository.")
		}
	case connect.ServiceTunnel:
		if creds.Tunnel == nil {
			return fmt.Errorf("Connect did not send any tunnel credentials.")
		}
		if creds.Tunnel.TunnelToken == "" {
			return fmt.Errorf("Connect did not send a tunnel token.")
		}
		if h.tunnelService == nil {
			return fmt.Errorf("Tunnel service is not available on this server.")
		}
		// Enable the tunnel with the Connect-provisioned token and start cloudflared.
		if err := h.tunnelService.Enable(network.TunnelProviderCloudflare, creds.Tunnel.TunnelToken); err != nil {
			return fmt.Errorf("Could not configure the tunnel service.")
		}
		if err := h.tunnelService.Start(context.Background()); err != nil {
			return fmt.Errorf("The tunnel was configured but could not be started. Check your network connection and try again from Settings.")
		}
		return nil

	case connect.ServiceAI:
		// Tunnel and AI credentials are applied by their respective services.
		return nil
	}

	return nil
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
