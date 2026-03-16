package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"syscall"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
)

// SetupHandler handles initial setup endpoints
type SetupHandler struct {
	authService  *auth.Service
	setupService *setup.Service
	docker       *docker.Client
	mailer       func() (*email.Sender, error)
	license      middleware.LicenseChecker
}

// NewSetupHandler creates a new SetupHandler
func NewSetupHandler(authService *auth.Service, setupService *setup.Service, dockerClient *docker.Client, license middleware.LicenseChecker) *SetupHandler {
	return &SetupHandler{
		authService:  authService,
		setupService: setupService,
		docker:       dockerClient,
		mailer:       email.NewSender,
		license:      license,
	}
}

// GetStatus handles GET /api/v1/setup/status
// Returns the current setup status (whether initial setup is complete)
// This endpoint is accessible without authentication
func (h *SetupHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	state, err := h.setupService.Ensure(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to check setup status")
		return
	}

	userStatus, _ := h.authService.GetSetupStatus(r.Context())
	licenseStatus := LicenseSnapshot(h.license)

	JSON(w, http.StatusOK, map[string]interface{}{
		"setup_state": state,
		"user_status": userStatus,
		"license":     licenseStatus,
	})
}

// CompleteSetup handles POST /api/v1/setup/complete
// Creates the initial admin user
// This endpoint is only accessible when setup is not complete
func (h *SetupHandler) CompleteSetup(w http.ResponseWriter, r *http.Request) {
	state, err := h.setupService.Ensure(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to load setup state")
		return
	}
	if state.Status == setup.StatusComplete {
		JSONError(w, http.StatusForbidden, "setup has already been completed")
		return
	}

	if state.Status == setup.StatusPending {
		if _, err := h.setupService.MarkInProgress(r.Context()); err != nil {
			JSONError(w, http.StatusInternalServerError, "failed to start setup: "+err.Error())
			return
		}
	}

	// First check if setup is already complete
	isComplete, err := h.authService.IsSetupComplete(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to check setup status")
		return
	}

	if isComplete {
		JSONError(w, http.StatusForbidden, "setup has already been completed")
		return
	}

	// Parse request
	var req auth.SetupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate
	if req.AdminUsername == "" {
		JSONError(w, http.StatusBadRequest, "admin_username is required")
		return
	}
	if req.AdminPassword == "" {
		JSONError(w, http.StatusBadRequest, "admin_password is required")
		return
	}
	if err := h.authService.ValidatePassword(req.AdminPassword); err != nil {
		JSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	// Complete setup
	user, err := h.authService.CompleteSetup(r.Context(), &req)
	if err != nil {
		if err == auth.ErrSetupAlreadyComplete {
			JSONError(w, http.StatusForbidden, "setup has already been completed")
			return
		}
		JSONError(w, http.StatusInternalServerError, "failed to complete setup: "+err.Error())
		return
	}

	// Generate tokens for the new admin user
	tokens, err := h.authService.Login(r.Context(), &auth.LoginRequest{
		Username: req.AdminUsername,
		Password: req.AdminPassword,
	})
	if err != nil {
		// User was created but login failed - still return success
		JSON(w, http.StatusCreated, map[string]interface{}{
			"message": "setup complete - please log in",
			"user":    user,
		})
		return
	}

	if _, err := h.setupService.MarkComplete(r.Context()); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to finalize setup: "+err.Error())
		return
	}

	// Set auth cookies to automatically log in the user
	secure := isSecureRequest(r)
	refreshExpiresAt := time.Now().Add(7 * 24 * time.Hour)
	http.SetCookie(w, &http.Cookie{
		Name:     "access_token",
		Value:    tokens.Tokens.AccessToken,
		Path:     "/",
		Expires:  time.Unix(tokens.Tokens.ExpiresAt, 0),
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   secure,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     "refresh_token",
		Value:    tokens.Tokens.RefreshToken,
		Path:     "/",
		Expires:  refreshExpiresAt,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   secure,
	})

	// Send a welcome email if SMTP is configured
	go h.sendWelcome(req.AdminEmail, req.AdminUsername)

	JSON(w, http.StatusCreated, map[string]interface{}{
		"message": "setup complete",
		"user":    tokens.User,
		"tokens":  tokens.Tokens,
		"license": LicenseSnapshot(h.license),
	})
}

func (h *SetupHandler) sendWelcome(to, username string) {
	if h.mailer == nil || to == "" {
		return
	}
	cfg := config.Get()
	if cfg == nil || !cfg.Notify.Enabled {
		return
	}
	m, err := h.mailer()
	if err != nil {
		return
	}
	subject := cfg.Notify.WelcomeSubject
	if subject == "" {
		subject = "Welcome to LibreServ"
	}
	bodyTmpl := cfg.Notify.WelcomeBody
	if bodyTmpl == "" {
		bodyTmpl = "Your LibreServ admin account is ready.\n\nUsername: {{.Username}}\n"
	}
	body, err := email.RenderTemplate(bodyTmpl, map[string]string{
		"Username": username,
		"Email":    to,
	})
	if err != nil {
		body = "Your LibreServ admin account is ready."
	}
	_ = m.Send([]string{to}, subject, body)
}

// Preflight runs a set of basic checks before setup continues
// GET /api/v1/setup/preflight
func (h *SetupHandler) Preflight(w http.ResponseWriter, r *http.Request) {
	results := map[string]interface{}{}
	allHealthy := true

	cfg := config.Get()
	if cfg == nil {
		JSONError(w, http.StatusInternalServerError, "configuration not loaded")
		return
	}

	check := func(name string, fn func() error) {
		if err := fn(); err != nil {
			results[name] = map[string]interface{}{"status": "failed", "error": err.Error()}
			allHealthy = false
		} else {
			results[name] = map[string]interface{}{"status": "ok"}
		}
	}

	check("docker", func() error {
		if h.docker == nil {
			return nil
		}
		return h.docker.HealthCheck()
	})

	check("database", func() error {
		return h.authService.DBHealth()
	})

	check("data_path_writable", func() error {
		return touchPath(cfg.Apps.DataPath)
	})
	check("logs_path_writable", func() error {
		return touchPath(cfg.Logging.Path)
	})

	check("disk_space", func() error {
		var stat syscall.Statfs_t
		if err := syscall.Statfs(cfg.Apps.DataPath, &stat); err != nil {
			return err
		}
		free := stat.Bavail * uint64(stat.Bsize)
		if free < 512*1024*1024 { // 512MB
			return fmt.Errorf("low disk space: %d bytes available", free)
		}
		results["disk_space_bytes_free"] = free
		return nil
	})

	check("smtp", func() error {
		// If SMTP is not configured, this passes silently
		if cfg.SMTP.Host == "" {
			results["smtp_configured"] = false
			return nil
		}
		if err := email.TestSMTP(cfg.SMTP); err != nil {
			return err
		}
		results["smtp_configured"] = true
		return nil
	})

	statusCode := http.StatusOK
	if !allHealthy {
		statusCode = http.StatusServiceUnavailable
	}

	JSON(w, statusCode, map[string]interface{}{
		"checks":  results,
		"healthy": allHealthy,
		"time":    time.Now().UTC(),
		"license": LicenseSnapshot(h.license),
	})
}

func touchPath(path string) error {
	if path == "" {
		return fmt.Errorf("path not configured")
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(path, ".probe")
	if err != nil {
		return err
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return nil
}
