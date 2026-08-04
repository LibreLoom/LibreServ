package handlers

import (
	"context"
	"crypto/rand"
	"crypto/sha1"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
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
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/podman"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/settings"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/util"
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
	mu              sync.Mutex
	authService     *auth.Service
	setupService    *setup.Service
	runtime         *podman.Client
	mailer          func() (*email.Sender, error)
	dnsProviderMgr  *network.DNSProviderManager
	acmeManager     *network.ACMEManager
	caddyManager    *network.CaddyManager
	settingsService *settings.Service
	dnsState        setupDNSState
}

func NewSetupHandler(
	authService *auth.Service,
	setupService *setup.Service,
	runtimeClient *podman.Client,
	dnsProviderMgr *network.DNSProviderManager,
	acmeManager *network.ACMEManager,
	caddyManager *network.CaddyManager,
	settingsService *settings.Service,
) *SetupHandler {
	return &SetupHandler{
		authService:     authService,
		setupService:    setupService,
		runtime:         runtimeClient,
		mailer:          email.NewSender,
		dnsProviderMgr:  dnsProviderMgr,
		acmeManager:     acmeManager,
		caddyManager:    caddyManager,
		settingsService: settingsService,
	}
}

// checkCertCapability returns whether cert issuance is possible and the method to use.
func (h *SetupHandler) checkCertCapability() (available bool, method string) {
	if h.runtime != nil {
		if err := h.runtime.HealthCheck(); err == nil {
			return true, "podman"
		}
	}
	if _, err := exec.LookPath("lego"); err == nil {
		return true, "binary"
	}
	return false, ""
}

func (h *SetupHandler) enableCaddy(ctx context.Context, domain, email string) error {
	if h.caddyManager == nil {
		return nil
	}

	if err := h.caddyManager.SetMode("enabled"); err != nil {
		return fmt.Errorf("set caddy mode: %w", err)
	}

	if err := h.caddyManager.UpdateDefaults(domain, email, true); err != nil {
		slog.Warn("Failed to update caddy defaults after enable", "error", err)
	}

	if h.settingsService != nil {
		proxyUpdates := map[string]interface{}{
			"proxy": map[string]interface{}{
				"mode":           "enabled",
				"default_domain": domain,
				"ssl_email":      email,
				"auto_https":     true,
			},
		}
		if err := h.settingsService.UpdateSettings(ctx, proxyUpdates); err != nil {
			slog.Warn("Failed to persist caddy settings to DB", "error", err)
		}
	}

	return nil
}

// GetStatus handles GET /api/v1/setup/status
// Returns the current setup status (whether initial setup is complete)
// This endpoint is accessible without authentication
func (h *SetupHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	state, err := h.setupService.Ensure(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't check your setup status. Please try again.")
		return
	}

	userStatus, _ := h.authService.GetSetupStatus(r.Context())
	state = h.reconcileSetupState(r.Context(), state, userStatus)
	state.Nonce = ""

	progress := map[string]interface{}{
		"current_step":     state.CurrentStep,
		"current_sub_step": state.CurrentSubStep,
		"step_data":        state.StepData,
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"setup_state":   state,
		"user_status":   userStatus,
		"progress":      progress,
		"code_required": !isLocalIP(r),
	})
}

// ValidateCode handles POST /api/v1/setup/validate-code
// Validates the setup code and returns success/failure.
// This is a separate step before the wizard begins so users get
// immediate feedback on whether their setup code is correct.
func (h *SetupHandler) ValidateCode(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}
	if req.Code == "" {
		JSONError(w, http.StatusBadRequest, "Please enter your setup code.")
		return
	}

	expected, err := h.setupService.SetupToken(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't check your setup code. Please try again.")
		return
	}

	submitted := strings.ToLower(strings.TrimSpace(req.Code))
	if subtle.ConstantTimeCompare([]byte(submitted), []byte(strings.ToLower(expected))) != 1 {
		JSONError(w, http.StatusForbidden, "Invalid setup code. Check the code on your device card and try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// CompleteSetup handles POST /api/v1/setup/complete
// Creates the initial admin user
// This endpoint is only accessible when setup is not complete
func (h *SetupHandler) CompleteSetup(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()

	state, err := h.setupService.Ensure(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load your setup progress. Please try again.")
		return
	}
	if state.Status == setup.StatusComplete {
		JSONError(w, http.StatusForbidden, "Setup is already complete.")
		return
	}

	if state.Status == setup.StatusPending {
		if _, err := h.setupService.MarkInProgress(r.Context()); err != nil {
			JSONError(w, http.StatusInternalServerError, "We couldn't start setup. Please try again.")
			return
		}
	}

	// First check if setup is already complete
	isComplete, err := h.authService.IsSetupComplete(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't check your setup status. Please try again.")
		return
	}

	if isComplete {
		JSONError(w, http.StatusForbidden, "Setup is already complete.")
		return
	}

	// Parse request
	var req auth.SetupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	// Validate
	if req.AdminUsername == "" {
		JSONError(w, http.StatusBadRequest, "Please provide an admin username.")
		return
	}
	if req.AdminPassword == "" {
		JSONError(w, http.StatusBadRequest, "Please provide an admin password.")
		return
	}
	if err := h.authService.ValidatePassword(req.AdminPassword); err != nil {
		msg := err.Error()
		JSONError(w, http.StatusBadRequest, msg)
		return
	}

	// Block passwords that appear in known data breaches (Have I Been Pwned).
	// Fail open when the HIBP API is unreachable so setup is never blocked by
	// an outage on our side or theirs.
	if breached, err := checkBreachedPassword(req.AdminPassword); err != nil {
		slog.Warn("HIBP breach check skipped: ", "error", err)
	} else if breached {
		JSONError(w, http.StatusBadRequest, "That password has appeared in known data breaches, so it isn't safe to use. Please choose a different password.")
		return
	}

	// Complete setup
	user, err := h.authService.CompleteSetup(r.Context(), &req)
	if err != nil {
		if err == auth.ErrSetupAlreadyComplete {
			JSONError(w, http.StatusForbidden, "Setup is already complete.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "We couldn't complete setup. Please try again.")
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
			"user":    user.Sanitize(),
		})
		return
	}

	// Set auth cookies to automatically log in the user
	refreshExpiresAt := time.Now().Add(7 * 24 * time.Hour)
	http.SetCookie(w, &http.Cookie{
		Name:     accessCookieName,
		Value:    tokens.Tokens.AccessToken,
		Path:     "/",
		Expires:  time.Unix(tokens.Tokens.ExpiresAt, 0),
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   true,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    tokens.Tokens.RefreshToken,
		Path:     "/",
		Expires:  refreshExpiresAt,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   true,
	})

	// Send a welcome email if SMTP is configured
	go h.sendWelcome(req.AdminEmail, req.AdminUsername)

	JSON(w, http.StatusCreated, map[string]interface{}{
		"message": "setup complete",
		"user":    tokens.User.Sanitize(),
		"tokens":  tokens.Tokens,
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
	state, err := h.setupService.Ensure(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load your setup progress. Please try again.")
		return
	}
	if state.Status == setup.StatusComplete {
		JSONError(w, http.StatusForbidden, "Setup is already complete.")
		return
	}

	results := map[string]interface{}{}
	allHealthy := true

	cfg := config.Get()
	if cfg == nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load the server configuration. Please try again later.")
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

	check("runtime", "system", func() error {
		if h.runtime == nil {
			return nil
		}
		if err := h.runtime.HealthCheck(); err != nil {
			results["runtime_optional"] = true
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
		return checkPathWritable(cfg.Apps.DataPath)
	})
	check("logs_path_writable", "storage", func() error {
		return checkPathWritable(filepath.Dir(cfg.Logging.Path))
	})

	if cfg.Network.Caddy.ConfigPath != "" {
		check("caddy_config_writable", "network", func() error {
			return checkPathWritable(filepath.Dir(cfg.Network.Caddy.ConfigPath))
		})
	}
	if cfg.Network.Caddy.CertsPath != "" {
		check("caddy_certs_writable", "network", func() error {
			return checkPathWritable(cfg.Network.Caddy.CertsPath)
		})
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
		diskFree = util.SafeDiskBytes(int64(stat.Bavail), stat.Bsize)
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
	})
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
	// Repair: if an admin user exists but the setup state machine thinks
	// we're still pending/in_progress, transition to complete.
	if state.Status != setup.StatusComplete && userStatus.SetupComplete {
		if _, err := h.setupService.MarkComplete(ctx); err != nil {
			slog.Warn("reconcileSetupState: failed to mark setup complete", "error", err)
		} else {
			// Re-read to get the updated state
			if repaired, err := h.setupService.Get(ctx); err == nil {
				return repaired
			}
		}
	}
	return state
}

// TestDNS handles POST /api/v1/setup/dns/test
// Validates DNS provider credentials without saving anything.
func (h *SetupHandler) TestDNS(w http.ResponseWriter, r *http.Request) {
	state, err := h.setupService.Ensure(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load your setup progress. Please try again.")
		return
	}
	if state.Status == setup.StatusComplete {
		JSONError(w, http.StatusForbidden, "Setup is already complete.")
		return
	}

	var req struct {
		Provider string `json:"provider"`
		Domain   string `json:"domain"`
		APIToken string `json:"api_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}
	if req.Provider == "" || req.Domain == "" || req.APIToken == "" {
		JSONError(w, http.StatusBadRequest, "Please fill in the provider, domain, and access key fields.")
		return
	}
	if req.Provider != "cloudflare" {
		JSONError(w, http.StatusBadRequest, "That provider isn't supported: "+req.Provider)
		return
	}

	if err := network.ValidateDomain(req.Domain); err != nil {
		slog.Warn("invalid domain during setup", "domain", req.Domain, "error", err)
		JSONError(w, http.StatusBadRequest, "That domain isn't valid. Please check it and try again.")
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
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}
	if req.Provider == "" || req.Domain == "" || req.APIToken == "" || req.Email == "" {
		JSONError(w, http.StatusBadRequest, "Please fill in the provider, domain, access key, and email fields.")
		return
	}

	publicIP, err := network.DetectPublicIP(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't determine your server's public address. Please try again.")
		return
	}

	cfg := &network.DNSProviderConfig{
		Provider: network.ProviderCloudflare,
		Domain:   req.Domain,
		APIToken: req.APIToken,
		Enabled:  true,
	}
	if err := h.dnsProviderMgr.SaveConfig(r.Context(), cfg); err != nil {
		slog.Error("Failed to save DNS config", "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't save your DNS settings. Please try again.")
		return
	}

	if err := h.dnsProviderMgr.SetupWildcardDNS(r.Context(), cfg, publicIP); err != nil {
		slog.Error("Failed to set up DNS records", "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't set up your DNS records. Please try again.")
		return
	}

	if err := h.enableCaddy(r.Context(), req.Domain, req.Email); err != nil {
		slog.Warn("Failed to enable caddy after domain setup", "error", err)
	}

	h.dnsState.mu.Lock()
	h.dnsState.domain = req.Domain
	h.dnsState.certDone = false
	h.dnsState.certError = ""
	h.dnsState.mu.Unlock()

	go func() {
		certAvail, certMethod := h.checkCertCapability()
		if certAvail && certMethod == "podman" {
			h.acmeManager.WithUsePodman(true)
		}
		err := h.acmeManager.RequestWildcardCert(context.Background(), req.Domain, req.Email, cfg)
		h.dnsState.mu.Lock()
		h.dnsState.certDone = true
		if err != nil {
			h.dnsState.certError = err.Error()
		}
		h.dnsState.mu.Unlock()
		h.acmeManager.ClearUsePodmanOverride()
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
		JSONError(w, http.StatusNotFound, "We couldn't find any DNS settings.")
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
		JSONError(w, http.StatusInternalServerError, "We couldn't load your setup progress. Please try again.")
		return
	}
	if state.Status == setup.StatusComplete {
		JSONError(w, http.StatusForbidden, "Setup is already complete.")
		return
	}

	var req struct {
		CurrentStep    string                 `json:"current_step"`
		CurrentSubStep string                 `json:"current_sub_step"`
		StepData       map[string]interface{} `json:"step_data"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if !setup.IsValidMainStep(req.CurrentStep) {
		JSONError(w, http.StatusBadRequest, "That step isn't valid: "+req.CurrentStep)
		return
	}
	if req.CurrentSubStep != "" && !setup.IsValidSubStep(req.CurrentSubStep) {
		JSONError(w, http.StatusBadRequest, "That sub-step isn't valid: "+req.CurrentSubStep)
		return
	}

	if req.StepData == nil {
		req.StepData = map[string]interface{}{}
	}
	if !setup.ValidateStepData(req.StepData) {
		JSONError(w, http.StatusBadRequest, "Your progress data contains fields that aren't allowed.")
		return
	}

	encoded, err := json.Marshal(req.StepData)
	if err != nil {
		JSONError(w, http.StatusBadRequest, "Your progress data isn't valid.")
		return
	}
	if len(encoded) > maxStepDataSize {
		JSONError(w, http.StatusBadRequest, "Your progress data is too large.")
		return
	}

	for _, v := range req.StepData {
		switch v.(type) {
		case string, bool, float64, int, int64, nil:
		default:
			if !isSimpleSlice(v) {
				JSONError(w, http.StatusBadRequest, "Progress values must be text, numbers, or true/false.")
				return
			}
		}
	}

	if err := h.setupService.SaveProgress(r.Context(), req.CurrentStep, req.CurrentSubStep, req.StepData); err != nil {
		if strings.Contains(err.Error(), "stale timestamp") {
			slog.Warn("setup progress save rejected due to stale timestamp",
				"step", req.CurrentStep, "sub_step", req.CurrentSubStep)
			JSONError(w, http.StatusConflict, "Your progress was changed by another action. Please try again.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "We couldn't save your progress. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{"ok": true})
}

func (h *SetupHandler) ResetProgress(w http.ResponseWriter, r *http.Request) {
	state, err := h.setupService.Ensure(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load your setup progress. Please try again.")
		return
	}
	if state.Status == setup.StatusComplete {
		JSONError(w, http.StatusForbidden, "Setup is already complete.")
		return
	}

	if err := h.setupService.ResetProgress(r.Context()); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't reset your progress. Please try again.")
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

// SaveSMTP handles PUT /api/v1/setup/smtp
// Saves SMTP configuration during setup (no setupGuard required).
func (h *SetupHandler) SaveSMTP(w http.ResponseWriter, r *http.Request) {
	state, err := h.setupService.Ensure(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load your setup progress. Please try again.")
		return
	}
	if state.Status == setup.StatusComplete {
		JSONError(w, http.StatusForbidden, "Setup is already complete.")
		return
	}

	var body struct {
		SMTP map[string]interface{} `json:"smtp"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || len(body.SMTP) == 0 {
		JSONError(w, http.StatusBadRequest, "Please provide your email (SMTP) settings.")
		return
	}

	if err := h.settingsService.UpdateSettings(r.Context(), map[string]interface{}{"smtp": body.SMTP}); err != nil {
		slog.Error("Failed to save SMTP settings during setup", "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't save your email settings. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{"message": "smtp settings saved"})
}

// TestSMTP handles POST /api/v1/setup/smtp/test
// Tests SMTP connection during setup (no setupGuard required).
func (h *SetupHandler) TestSMTP(w http.ResponseWriter, r *http.Request) {
	state, stateErr := h.setupService.Ensure(r.Context())
	if stateErr != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load your setup progress. Please try again.")
		return
	}
	if state.Status == setup.StatusComplete {
		JSONError(w, http.StatusForbidden, "Setup is already complete.")
		return
	}

	var body struct {
		To   string             `json:"to"`
		SMTP *config.SMTPConfig `json:"smtp,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.To == "" {
		JSONError(w, http.StatusBadRequest, "Please provide a recipient email address.")
		return
	}

	var mailer *email.Sender
	var err error
	if body.SMTP != nil {
		mailer, err = email.NewSenderWithConfig(*body.SMTP)
	} else if h.mailer != nil {
		mailer, err = h.mailer()
	} else {
		JSONError(w, http.StatusInternalServerError, "Please provide your email (SMTP) settings first.")
		return
	}
	if err != nil {
		slog.Error("Failed to set up SMTP for test email", "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't send the test email. Please check your email settings and try again.")
		return
	}
	if err := mailer.Send([]string{body.To}, "LibreServ SMTP Test", "This is a test email from LibreServ."); err != nil {
		slog.Error("Failed to send test email", "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't send the test email. Please check your email settings and try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]interface{}{
		"status": "sent",
		"to":     body.To,
	})
}

// FinalizeSetup handles POST /api/v1/setup/finalize
// Marks setup as complete after all steps are done.
func (h *SetupHandler) FinalizeSetup(w http.ResponseWriter, r *http.Request) {
	state, err := h.setupService.Ensure(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load your setup progress. Please try again.")
		return
	}
	if state.Status == setup.StatusComplete {
		JSONError(w, http.StatusForbidden, "Setup is already complete.")
		return
	}

	if _, err := h.setupService.MarkComplete(r.Context()); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't finish setup. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{"message": "setup finalized"})
}

// hibpRangeURL is the Have I Been Pwned k-anonymity range endpoint.
// Only the first 5 hex chars of the password's SHA-1 hash are sent to it.
var hibpRangeURL = "https://api.pwnedpasswords.com/range/"

// SetHIBPRangeURL overrides the HIBP range endpoint (tests only).
func SetHIBPRangeURL(url string) { hibpRangeURL = url }

// checkBreachedPassword reports whether pw appears in known data breaches
// (Have I Been Pwned). It sends only the first 5 hex chars of the SHA-1
// hash to the range API and matches the remainder locally — the full
// password never leaves the server. On any API/network error it returns
// (false, err) so callers can fail open.
func checkBreachedPassword(pw string) (bool, error) {
	sum := sha1.Sum([]byte(pw)) // #nosec G401 -- SHA-1 is required by the HIBP range API; only a 5-char prefix is transmitted
	full := strings.ToUpper(hex.EncodeToString(sum[:]))
	prefix, suffix := full[:5], full[5:]

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, hibpRangeURL+prefix, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("User-Agent", "LibreServ")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return false, fmt.Errorf("hibp range api returned %s", resp.Status)
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return false, err
	}

	// Response is lines of "SUFFIX:COUNT" for every hash sharing our prefix.
	for _, line := range strings.Split(string(body), "\n") {
		if strings.HasPrefix(line, suffix+":") {
			return true, nil
		}
	}
	return false, nil
}

// isLocalIP returns true when the request originates from the local machine.
// Display mode (loopback) is exempt from needing a setup code.
// When behind a trusted proxy (Vite dev server, Caddy), forwarded headers
// are checked to find the real client IP.
func isLocalIP(r *http.Request) bool {
	host := r.RemoteAddr
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	remote := net.ParseIP(host)
	if remote == nil {
		return false
	}

	if !remote.IsLoopback() {
		return false
	}

	// RemoteAddr is loopback — could be a direct connection or a proxy.
	// If from a trusted proxy, check forwarded headers for the real client IP.
	if isTrustedProxyIP(remote) {
		for _, header := range []string{"X-Forwarded-For", "X-Real-IP"} {
			if val := r.Header.Get(header); val != "" {
				parts := strings.Split(val, ",")
				ipStr := strings.TrimSpace(parts[len(parts)-1])
				if ip := net.ParseIP(ipStr); ip != nil {
					return ip.IsLoopback()
				}
			}
		}
	}

	return true
}

func isTrustedProxyIP(ip net.IP) bool {
	for _, network := range middleware.TrustedProxyNets() {
		if network.Contains(ip) {
			return true
		}
	}
	return false
}
