package handlers

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
)

// setupDNSState holds the async cert issuance result for DNS setup
type setupDNSState struct {
	mu        sync.RWMutex
	domain    string
	certDone  bool
	certError string
}

// SetupHandler handles initial setup endpoints
type SetupHandler struct {
	authService    *auth.Service
	setupService   *setup.Service
	docker         *docker.Client
	mailer         func() (*email.Sender, error)
	license        middleware.LicenseChecker
	dnsProviderMgr *network.DNSProviderManager
	acmeManager    *network.ACMEManager
	dnsState       setupDNSState
}

// NewSetupHandler creates a new SetupHandler
func NewSetupHandler(
	authService *auth.Service,
	setupService *setup.Service,
	dockerClient *docker.Client,
	license middleware.LicenseChecker,
	dnsProviderMgr *network.DNSProviderManager,
	acmeManager *network.ACMEManager,
) *SetupHandler {
	return &SetupHandler{
		authService:    authService,
		setupService:   setupService,
		docker:         dockerClient,
		mailer:         email.NewSender,
		license:        license,
		dnsProviderMgr: dnsProviderMgr,
		acmeManager:    acmeManager,
	}
}

// checkCertCapability returns whether cert issuance is possible and the method to use.
func (h *SetupHandler) checkCertCapability() (available bool, method string) {
	if h.docker != nil {
		if err := h.docker.HealthCheck(); err == nil {
			return true, "docker"
		}
	}
	if _, err := exec.LookPath("lego"); err == nil {
		return true, "binary"
	}
	return false, ""
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
	state = h.reconcileSetupState(r.Context(), state, userStatus)
	licenseStatus := LicenseSnapshot(h.license)

	progress := map[string]interface{}{
		"current_step":     state.CurrentStep,
		"current_sub_step": state.CurrentSubStep,
		"step_data":        state.StepData,
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"setup_state": state,
		"user_status": userStatus,
		"license":     licenseStatus,
		"progress":    progress,
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
			JSONError(w, http.StatusInternalServerError, "failed to start setup")
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
		JSONError(w, http.StatusBadRequest, "password does not meet requirements")
		return
	}

	// Complete setup
	user, err := h.authService.CompleteSetup(r.Context(), &req)
	if err != nil {
		if err == auth.ErrSetupAlreadyComplete {
			JSONError(w, http.StatusForbidden, "setup has already been completed")
			return
		}
		JSONError(w, http.StatusInternalServerError, "failed to complete setup")
		return
	}

	if _, err := h.setupService.MarkComplete(r.Context()); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to finalize setup")
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

	check := func(name, category string, fn func() error) {
		if err := fn(); err != nil {
			results[name] = map[string]interface{}{
				"status":   "failed",
				"error":    err.Error(),
				"category": category,
			}
			allHealthy = false
		} else {
			results[name] = map[string]interface{}{
				"status":   "ok",
				"category": category,
			}
		}
	}

	check("docker", "system", func() error {
		if h.docker == nil {
			return nil
		}
		if err := h.docker.HealthCheck(); err != nil {
			results["docker_optional"] = true
			return nil
		}
		return nil
	})

	check("database", "system", func() error {
		return h.authService.DBHealth()
	})

	check("database_writable", "storage", func() error {
		return checkPathWritable(filepath.Dir(cfg.Database.Path))
	})

	check("data_path_writable", "storage", func() error {
		return touchPath(cfg.Apps.DataPath)
	})
	check("logs_path_writable", "storage", func() error {
		return touchPath(cfg.Logging.Path)
	})

	if cfg.Network.Caddy.Mode != "disabled" && cfg.Network.Caddy.Mode != "noop" {
		if cfg.Network.Caddy.ConfigPath != "" {
			check("caddy_config_writable", "network", func() error {
				return checkPathWritable(cfg.Network.Caddy.ConfigPath)
			})
		}
		if cfg.Network.Caddy.CertsPath != "" {
			check("caddy_certs_writable", "network", func() error {
				return checkPathWritable(cfg.Network.Caddy.CertsPath)
			})
		}
	}

	if cfg.Network.ACME.External.Enabled {
		if cfg.Network.ACME.External.DataPath != "" {
			check("acme_data_writable", "network", func() error {
				return checkPathWritable(cfg.Network.ACME.External.DataPath)
			})
		}
		if cfg.Network.ACME.External.CertsPath != "" {
			check("acme_certs_writable", "network", func() error {
				return checkPathWritable(cfg.Network.ACME.External.CertsPath)
			})
		}
	}

	var diskFree uint64
	check("disk_space", "system", func() error {
		resolvedPath, err := resolveConfigPath(cfg.Apps.DataPath)
		if err != nil {
			return err
		}
		var stat syscall.Statfs_t
		if err := syscall.Statfs(resolvedPath, &stat); err != nil {
			return err
		}
		diskFree = stat.Bavail * uint64(stat.Bsize)
		if diskFree < 512*1024*1024 {
			return fmt.Errorf("low disk space")
		}
		return nil
	})
	// Attach detail to the disk_space check result
	if m, ok := results["disk_space"].(map[string]interface{}); ok && diskFree > 0 {
		m["disk_space_bytes_free"] = diskFree
	}

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
	return checkPathWritable(path)
}

func checkPathWritable(path string) error {
	resolved, err := resolveConfigPath(path)
	if err != nil {
		return fmt.Errorf("not configured")
	}

	if info, err := os.Stat(resolved); err == nil && info.IsDir() {
		testDir := filepath.Join(resolved, ".perm-check-"+randomSuffix(8))
		if err := os.Mkdir(testDir, 0755); err != nil {
			slog.Error("preflight permission check failed",
				"path", resolved,
				"error", err,
				"uid", os.Getuid(),
				"gid", os.Getgid())
			return fmt.Errorf("cannot write to storage")
		}
		_ = os.Remove(testDir)

		f, err := os.CreateTemp(resolved, ".probe")
		if err != nil {
			slog.Error("preflight write check failed", "path", resolved, "error", err)
			return fmt.Errorf("cannot write to storage")
		}
		name := f.Name()
		_ = f.Close()
		_ = os.Remove(name)
		return nil
	}

	if err := os.MkdirAll(resolved, 0755); err != nil {
		slog.Error("preflight directory creation failed", "path", resolved, "error", err)
		return fmt.Errorf("cannot create storage")
	}

	f, err := os.CreateTemp(resolved, ".probe")
	if err != nil {
		slog.Error("preflight write check failed", "path", resolved, "error", err)
		return fmt.Errorf("cannot write to storage")
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return nil
}

func randomSuffix(n int) string {
	b := make([]byte, n)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)[:n]
}

func resolveConfigPath(path string) (string, error) {
	return config.ResolveConfigPath(path)
}

func (h *SetupHandler) reconcileSetupState(ctx context.Context, state *setup.State, userStatus *auth.SetupStatus) *setup.State {
	if state == nil || userStatus == nil {
		return state
	}
	if state.Status == setup.StatusComplete || !userStatus.SetupComplete {
		return state
	}

	updated, err := h.setupService.MarkComplete(ctx)
	if err != nil {
		return state
	}
	return updated
}

// TestDNS handles POST /api/v1/setup/dns/test
// Validates DNS provider credentials without saving anything.
func (h *SetupHandler) TestDNS(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider string `json:"provider"`
		Domain   string `json:"domain"`
		APIToken string `json:"api_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Provider == "" || req.Domain == "" || req.APIToken == "" {
		JSONError(w, http.StatusBadRequest, "provider, domain, and api_token are required")
		return
	}
	if req.Provider != "cloudflare" {
		JSONError(w, http.StatusBadRequest, "unsupported provider: "+req.Provider)
		return
	}

	if err := network.ValidateDomain(req.Domain); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid domain: "+err.Error())
		return
	}

	cfg := &network.DNSProviderConfig{
		Provider: network.ProviderCloudflare,
		Domain:   req.Domain,
		APIToken: req.APIToken,
	}
	if err := h.dnsProviderMgr.ValidateCredentials(r.Context(), cfg); err != nil {
		JSON(w, http.StatusOK, map[string]interface{}{
			"valid": false,
			"error": "Invalid API token or zone not found",
		})
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"valid":  true,
		"zone":   cfg.Zone(),
		"domain": req.Domain,
	})
}

// ApplyDNS handles POST /api/v1/setup/dns/apply
// Saves DNS config, creates DNS records, kicks off cert request asynchronously.
func (h *SetupHandler) ApplyDNS(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider string `json:"provider"`
		Domain   string `json:"domain"`
		APIToken string `json:"api_token"`
		Email    string `json:"email"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Provider == "" || req.Domain == "" || req.APIToken == "" || req.Email == "" {
		JSONError(w, http.StatusBadRequest, "provider, domain, api_token, and email are required")
		return
	}

	publicIP, err := network.DetectPublicIP(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to detect public IP")
		return
	}

	cfg := &network.DNSProviderConfig{
		Provider: network.ProviderCloudflare,
		Domain:   req.Domain,
		APIToken: req.APIToken,
		Enabled:  true,
	}
	if err := h.dnsProviderMgr.SaveConfig(r.Context(), cfg); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to save DNS config: "+err.Error())
		return
	}

	if err := h.dnsProviderMgr.SetupWildcardDNS(r.Context(), cfg, publicIP); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to set up DNS records: "+err.Error())
		return
	}

	h.dnsState.mu.Lock()
	h.dnsState.domain = req.Domain
	h.dnsState.certDone = false
	h.dnsState.certError = ""
	h.dnsState.mu.Unlock()

	go func() {
		certAvail, certMethod := h.checkCertCapability()
		if certAvail && certMethod == "docker" {
			h.acmeManager.WithUseDocker(true)
		}
		err := h.acmeManager.RequestWildcardCert(context.Background(), req.Domain, req.Email, cfg)
		h.dnsState.mu.Lock()
		h.dnsState.certDone = true
		if err != nil {
			h.dnsState.certError = err.Error()
		}
		h.dnsState.mu.Unlock()
		h.acmeManager.ClearUseDockerOverride()
		if err != nil {
			slog.Error("wildcard cert request failed", "domain", req.Domain, "error", err)
		} else {
			slog.Info("wildcard cert issued", "domain", req.Domain)
		}
	}()

	JSON(w, http.StatusAccepted, map[string]interface{}{
		"status":    "in_progress",
		"public_ip": publicIP.String(),
	})
}

// GetDNSStatus handles GET /api/v1/setup/dns/status
// Polls the status of the DNS setup and cert issuance.
func (h *SetupHandler) GetDNSStatus(w http.ResponseWriter, r *http.Request) {
	cfg, err := h.dnsProviderMgr.GetConfig(r.Context())
	if err != nil || cfg == nil {
		JSONError(w, http.StatusNotFound, "no DNS config found")
		return
	}

	publicIP, _ := network.DetectPublicIP(r.Context())

	h.dnsState.mu.RLock()
	certDone := h.dnsState.certDone
	certError := h.dnsState.certError
	h.dnsState.mu.RUnlock()

	dnsStatus := "done"
	certStatus := "pending"
	if certDone && certError != "" {
		certStatus = "failed"
	} else if certDone && certError == "" {
		certStatus = "done"
	}

	publicIPStr := ""
	if publicIP.IsValid() {
		publicIPStr = publicIP.String()
	}

	certAvail, certMethod := h.checkCertCapability()

	JSON(w, http.StatusOK, map[string]interface{}{
		"dns_records":    dnsStatus,
		"certificate":    certStatus,
		"public_ip":      publicIPStr,
		"domain":         cfg.Domain,
		"error":          nil,
		"cert_available": certAvail,
		"cert_method":    certMethod,
	})
}

const maxStepDataSize = 4096

func (h *SetupHandler) SaveProgress(w http.ResponseWriter, r *http.Request) {
	state, err := h.setupService.Ensure(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to load setup state")
		return
	}
	if state.Status == setup.StatusComplete {
		JSONError(w, http.StatusForbidden, "setup has already been completed")
		return
	}

	var req struct {
		CurrentStep    string                 `json:"current_step"`
		CurrentSubStep string                 `json:"current_sub_step"`
		StepData       map[string]interface{} `json:"step_data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if !setup.IsValidMainStep(req.CurrentStep) {
		JSONError(w, http.StatusBadRequest, "invalid current_step: "+req.CurrentStep)
		return
	}
	if req.CurrentSubStep != "" && !setup.IsValidSubStep(req.CurrentSubStep) {
		JSONError(w, http.StatusBadRequest, "invalid current_sub_step: "+req.CurrentSubStep)
		return
	}

	if req.StepData == nil {
		req.StepData = map[string]interface{}{}
	}
	if !setup.ValidateStepData(req.StepData) {
		JSONError(w, http.StatusBadRequest, "step_data contains disallowed keys")
		return
	}

	encoded, err := json.Marshal(req.StepData)
	if err != nil {
		JSONError(w, http.StatusBadRequest, "invalid step_data")
		return
	}
	if len(encoded) > maxStepDataSize {
		JSONError(w, http.StatusBadRequest, "step_data too large")
		return
	}

	for _, v := range req.StepData {
		switch v.(type) {
		case string, bool, float64, int, int64, nil:
		default:
			if !isSimpleSlice(v) {
				JSONError(w, http.StatusBadRequest, "step_data values must be strings, numbers, or booleans")
				return
			}
		}
	}

	if err := h.setupService.SaveProgress(r.Context(), req.CurrentStep, req.CurrentSubStep, req.StepData); err != nil {
		if strings.Contains(err.Error(), "stale timestamp") {
			slog.Warn("setup progress save rejected due to stale timestamp",
				"step", req.CurrentStep, "sub_step", req.CurrentSubStep)
			JSON(w, http.StatusOK, map[string]interface{}{"ok": true, "stale": true})
			return
		}
		JSONError(w, http.StatusInternalServerError, "failed to save progress")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func isSimpleSlice(v interface{}) bool {
	arr, ok := v.([]interface{})
	if !ok {
		return false
	}
	for _, el := range arr {
		switch el.(type) {
		case string, bool, float64, int, int64, nil:
		default:
			return false
		}
	}
	return true
}
