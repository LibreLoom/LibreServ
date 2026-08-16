package handlers

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/catalog"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/services"
)

// PortalHandler handles customer-facing self-service API.
type PortalHandler struct {
	db          *sql.DB
	billing     *billing.Service
	registrar   *providers.RegistrarClient
	providers   *providers.Service
	resend      *providers.ResendClient
	domainCoord *services.DomainCoordinator
	// emailRateLimit tracks per-account email sends to prevent runaway loops.
	emailRateLimit sync.Map // accountID → []time.Time
}

func NewPortalHandler(db *sql.DB) *PortalHandler {
	return &PortalHandler{
		db:          db,
		billing:     billing.NewService(db),
		registrar:   providers.NewRegistrarClient(nil),
		providers:   providers.NewService(db),
		resend:      providers.NewResendClient(nil),
		domainCoord: services.NewDomainCoordinator(db),
	}
}

// emailRateLimitOK checks whether the account can send another email.
// Allows at most 3 sends per 60-second window per account.
func (h *PortalHandler) emailRateLimitOK(accountID string) bool {
	now := time.Now()
	cutoff := now.Add(-60 * time.Second)
	var recent []time.Time
	if v, ok := h.emailRateLimit.Load(accountID); ok {
		for _, t := range v.([]time.Time) {
			if t.After(cutoff) {
				recent = append(recent, t)
			}
		}
	}
	if len(recent) >= 3 {
		h.emailRateLimit.Store(accountID, recent)
		return false
	}
	recent = append(recent, now)
	h.emailRateLimit.Store(accountID, recent)
	return true
}

// isValidUsername checks that a username contains only letters, numbers,
// and hyphens, and is 3-30 characters long.
func isValidUsername(s string) bool {
	if len(s) < 3 || len(s) > 30 {
		return false
	}
	for _, c := range s {
		if !((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-') {
			return false
		}
	}
	return true
}

// Register creates a new customer account.
func (h *PortalHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		Name     string `json:"name"`
		Username string `json:"username"`
		Source   string `json:"source"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" || req.Password == "" {
		JSONError(w, http.StatusBadRequest, "email and password required")
		return
	}
	if len(req.Password) < 8 {
		JSONError(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}
	// Normalize username: lowercase, strip spaces, validate format
	req.Username = strings.ToLower(strings.TrimSpace(req.Username))
	if req.Username == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a username. This becomes your sending address (username@resend.libreloom.org).")
		return
	}
	if !isValidUsername(req.Username) {
		JSONError(w, http.StatusBadRequest, "Username can only contain letters, numbers, and hyphens (3-30 characters).")
		return
	}

	hash, err := auth.HashPassword(req.Password)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not hash password")
		return
	}

	// Generate a per-user SMTP password for the Connect SMTP relay
	smtpPassword := security.RandomPassword(32)

	accountID := security.GenerateID("acct")
	_, err = h.db.ExecContext(r.Context(),
		`INSERT INTO customer_accounts (id, email, password_hash, name, plan_id, email_verified, username, smtp_password)
		 VALUES ($1, $2, $3, $4, 'free', FALSE, $5, $6)`,
		accountID, req.Email, hash, req.Name, req.Username, smtpPassword)
	if err != nil {
		if strings.Contains(err.Error(), "username") {
			JSONError(w, http.StatusConflict, "That username is already taken. Please choose another.")
		} else {
			JSONError(w, http.StatusConflict, "an account with this email already exists")
		}
		return
	}

	// Auto sign-in: create a session so the user doesn't have to sign in again
	token, err := middleware.CreateCustomerSession(h.db, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create session")
		return
	}

	// Send verification email (best-effort — don't fail registration if email is down)
	verificationToken, _ := h.createEmailVerificationToken(r.Context(), accountID)
	if verificationToken != "" {
		go h.sendVerificationEmail(req.Email, verificationToken, req.Source)
	}

	JSON(w, http.StatusOK, map[string]any{
		"message":        "account created",
		"token":          token,
		"id":             accountID,
		"email":          req.Email,
		"name":           req.Name,
		"username":       req.Username,
		"plan_id":        "free",
		"has_2fa":        false,
		"email_verified": false,
	})
}

// VerifyEmail confirms an account's email address using a verification token.
func (h *PortalHandler) VerifyEmail(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" {
		JSONError(w, http.StatusBadRequest, "verification token required")
		return
	}

	tokenHash := hashToken(req.Token)
	var accountID string
	err := h.db.QueryRowContext(r.Context(),
		`SELECT account_id FROM email_verification_tokens
		 WHERE token_hash = $1 AND expires_at > CURRENT_TIMESTAMP`,
		tokenHash).Scan(&accountID)
	if err != nil {
		JSONError(w, http.StatusBadRequest, "This verification link is invalid or has expired. Request a new one.")
		return
	}

	_, err = h.db.ExecContext(r.Context(),
		"UPDATE customer_accounts SET email_verified = TRUE WHERE id = $1", accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not verify email")
		return
	}

	// Delete the used token
	_, _ = h.db.ExecContext(r.Context(),
		"DELETE FROM email_verification_tokens WHERE token_hash = $1", tokenHash)

	JSON(w, http.StatusOK, map[string]any{
		"message": "Your email has been verified. You can now use all Connect features.",
	})
}

// ResendVerification sends a new verification email to the authenticated user.
func (h *PortalHandler) ResendVerification(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Source string `json:"source"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	accountID := middleware.GetCustomerDeviceID(r.Context())

	var email string
	err := h.db.QueryRowContext(r.Context(),
		"SELECT email FROM customer_accounts WHERE id = $1", accountID).Scan(&email)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not find account")
		return
	}

	// Check if already verified
	var verified bool
	_ = h.db.QueryRowContext(r.Context(),
		"SELECT email_verified FROM customer_accounts WHERE id = $1", accountID).Scan(&verified)
	if verified {
		JSONError(w, http.StatusBadRequest, "Your email is already verified.")
		return
	}

	// Rate limit: max 3 verification emails per minute per account.
	if !h.emailRateLimitOK(accountID) {
		JSONError(w, http.StatusTooManyRequests, "Too many verification emails sent. Wait a minute and try again.")
		return
	}

	token, err := h.createEmailVerificationToken(r.Context(), accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not generate verification email")
		return
	}

	if err := h.sendVerificationEmailSync(email, token, req.Source); err != nil {
		slog.Error("failed to send verification email", "error", err, "account", accountID)
		JSONError(w, http.StatusInternalServerError, "We couldn't send the verification email. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"message": "Verification email sent. Check your inbox (and spam folder).",
	})
}

// GetVerificationStatus reports whether the authenticated account's email is
// verified. Deliberately NOT gated by RequireVerifiedEmail — the onboarding
// flow polls it to detect when the user clicks the link in their inbox.
func (h *PortalHandler) GetVerificationStatus(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var verified bool
	err := h.db.QueryRowContext(r.Context(),
		"SELECT email_verified FROM customer_accounts WHERE id = $1", accountID).Scan(&verified)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not find account")
		return
	}

	JSON(w, http.StatusOK, map[string]any{"email_verified": verified})
}

// GetMe returns the authenticated account's profile. Used by the portal SPA to
// restore the session account after a page reload. Deliberately NOT gated by
// RequireVerifiedEmail — unverified users must be able to load their own
// profile to see the verification-blocked state.
func (h *PortalHandler) GetMe(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var (
		id, email, name, planID, username string
		emailVerified, totpEnabled        bool
	)
	err := h.db.QueryRowContext(r.Context(),
		`SELECT id, email, name, plan_id, COALESCE(username, ''), email_verified, totp_enabled
		 FROM customer_accounts WHERE id = $1`, accountID).
		Scan(&id, &email, &name, &planID, &username, &emailVerified, &totpEnabled)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not find account")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"id":             id,
		"email":          email,
		"name":           name,
		"username":       username,
		"plan_id":        planID,
		"email_verified": emailVerified,
		"has_2fa":        totpEnabled,
	})
}

// createEmailVerificationToken generates a verification token, stores its hash,
// and returns the raw token to embed in a verification link.
func (h *PortalHandler) createEmailVerificationToken(ctx context.Context, accountID string) (string, error) {
	// Delete any existing tokens for this account
	_, _ = h.db.ExecContext(ctx, "DELETE FROM email_verification_tokens WHERE account_id = $1", accountID)

	token := security.GenerateToken("verify")
	tokenHash := hashToken(token)
	tokenID := security.GenerateID("evt")

	_, err := h.db.ExecContext(ctx,
		`INSERT INTO email_verification_tokens (id, account_id, token_hash) VALUES ($1, $2, $3)`,
		tokenID, accountID, tokenHash)
	if err != nil {
		return "", err
	}
	return token, nil
}

// sendVerificationEmail sends the verification email asynchronously.
func (h *PortalHandler) sendVerificationEmail(email, token, source string) {
	if err := h.sendVerificationEmailSync(email, token, source); err != nil {
		slog.Error("failed to send verification email", "error", err, "email", email)
	}
}

// sendVerificationEmailSync builds and sends the verification email.
func (h *PortalHandler) sendVerificationEmailSync(email, token, source string) error {
	baseURL := config.C.Server.BaseURL
	if baseURL == "" {
		baseURL = "https://connect.serv.libreloom.org"
	}
	verifyURL := baseURL + "/verify-email?token=" + token
	if source == "onboarding" {
		verifyURL += "&from=onboarding"
	}

	htmlBody := fmt.Sprintf(`<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #333;">Verify your email address</h2>
  <p style="color: #555; line-height: 1.6;">
    Welcome to LibreServ Connect! Click the button below to verify your email address.
    This confirms that you own this email and unlocks all Connect features.
  </p>
  <p style="text-align: center; margin: 30px 0;">
    <a href="%s" style="background: #000; color: #fff; padding: 12px 32px; border-radius: 9999px; text-decoration: none; font-family: monospace;">
      Verify my email
    </a>
  </p>
  <p style="color: #888; font-size: 13px;">
    If the button doesn't work, copy and paste this link into your browser:<br>
    <a href="%s" style="color: #666;">%s</a>
  </p>
  <p style="color: #888; font-size: 13px;">
    This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.
  </p>
</body>
</html>`, verifyURL, verifyURL, verifyURL)

	// Send via Resend REST API (API key stored in service_providers table)
	prov, err := h.providers.FindEnabled("smtp")
	if err != nil || prov == nil {
		return fmt.Errorf("no email provider configured. Add Resend in Settings → Service Providers")
	}
	apiKey := prov.Credential("api_key", "")
	if apiKey == "" {
		return fmt.Errorf("resend API key not configured")
	}
	from := config.C.SMTP.From
	if from == "" {
		from = "LibreServ Connect <noreply@resend.libreloom.org>"
	}
	return h.resend.SendEmail(apiKey, from, email, "Verify your email — LibreServ Connect", htmlBody, "")
}

// Login authenticates a customer with email/password (and TOTP if enabled).
func (h *PortalHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email    string `json:"email"`
		Password string `json:"password"`
		TOTPCode string `json:"totp_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Email == "" || req.Password == "" {
		JSONError(w, http.StatusBadRequest, "email and password required")
		return
	}

	var account struct {
		ID            string
		PasswordHash  string
		Name          sql.NullString
		TOTPSecret    sql.NullString
		TOTPEnabled   bool
		IsActive      bool
		PlanID        string
		EmailVerified bool
		Username      sql.NullString
	}
	err := h.db.QueryRowContext(r.Context(),
		`SELECT id, password_hash, name, totp_secret, totp_enabled, is_active, plan_id, email_verified, username
		 FROM customer_accounts WHERE email = $1`,
		req.Email).Scan(&account.ID, &account.PasswordHash, &account.Name, &account.TOTPSecret,
		&account.TOTPEnabled, &account.IsActive, &account.PlanID, &account.EmailVerified, &account.Username)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not authenticate")
		return
	}
	if !account.IsActive {
		JSONError(w, http.StatusForbidden, "account is disabled")
		return
	}

	if err := auth.VerifyPassword(account.PasswordHash, req.Password); err != nil {
		JSONError(w, http.StatusUnauthorized, "invalid email or password")
		return
	}

	if account.TOTPEnabled && account.TOTPSecret.Valid {
		if req.TOTPCode == "" {
			JSON(w, http.StatusOK, map[string]any{
				"requires_2fa": true,
				"message":      "Enter your authenticator code to continue.",
			})
			return
		}
		if !auth.VerifyTOTP(account.TOTPSecret.String, req.TOTPCode) {
			JSONError(w, http.StatusUnauthorized, "invalid authenticator code")
			return
		}
	}

	token, err := middleware.CreateCustomerSession(h.db, account.ID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create session")
		return
	}

	name := ""
	if account.Name.Valid {
		name = account.Name.String
	}
	username := ""
	if account.Username.Valid {
		username = account.Username.String
	}

	JSON(w, http.StatusOK, map[string]any{
		"token":          token,
		"id":             account.ID,
		"email":          req.Email,
		"name":           name,
		"username":       username,
		"plan_id":        account.PlanID,
		"has_2fa":        account.TOTPEnabled,
		"email_verified": account.EmailVerified,
	})
}

// Setup2FA generates a TOTP secret and returns the QR URI.
func (h *PortalHandler) Setup2FA(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	secret, err := auth.GenerateTOTPSecret()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not generate secret")
		return
	}

	var email string
	_ = h.db.QueryRowContext(r.Context(),
		"SELECT email FROM customer_accounts WHERE id = $1", accountID).Scan(&email)

	uri := auth.TOTPURI(secret, email, "LibreServ Connect")

	_, err = h.db.ExecContext(r.Context(),
		"UPDATE customer_accounts SET totp_secret = $1 WHERE id = $2", secret, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not save secret")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"secret": secret,
		"uri":    uri,
	})
}

// Verify2FA verifies a TOTP code and enables 2FA.
func (h *PortalHandler) Verify2FA(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Code == "" {
		JSONError(w, http.StatusBadRequest, "code required")
		return
	}

	var secret sql.NullString
	err := h.db.QueryRowContext(r.Context(),
		"SELECT totp_secret FROM customer_accounts WHERE id = $1", accountID).Scan(&secret)
	if err != nil || !secret.Valid {
		JSONError(w, http.StatusBadRequest, "set up 2FA first")
		return
	}

	if !auth.VerifyTOTP(secret.String, req.Code) {
		JSONError(w, http.StatusUnauthorized, "invalid code")
		return
	}

	_, err = h.db.ExecContext(r.Context(),
		"UPDATE customer_accounts SET totp_enabled = TRUE, updated_at = $1 WHERE id = $2", time.Now(), accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not enable 2FA")
		return
	}

	JSON(w, http.StatusOK, map[string]string{"message": "2FA enabled"})
}

// Disable2FA turns off 2FA (requires current TOTP code).
func (h *PortalHandler) Disable2FA(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Code == "" {
		JSONError(w, http.StatusBadRequest, "code required")
		return
	}

	var secret sql.NullString
	err := h.db.QueryRowContext(r.Context(),
		"SELECT totp_secret FROM customer_accounts WHERE id = $1", accountID).Scan(&secret)
	if err != nil || !secret.Valid {
		JSONError(w, http.StatusBadRequest, "2FA not configured")
		return
	}

	if !auth.VerifyTOTP(secret.String, req.Code) {
		JSONError(w, http.StatusUnauthorized, "invalid code")
		return
	}

	_, err = h.db.ExecContext(r.Context(),
		"UPDATE customer_accounts SET totp_enabled = FALSE, totp_secret = NULL, updated_at = $1 WHERE id = $2",
		time.Now(), accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not disable 2FA")
		return
	}

	JSON(w, http.StatusOK, map[string]string{"message": "2FA disabled"})
}

// GenerateConnectKey creates or regenerates the one Connect key for this account.
// If an unused/revoked key exists, it is replaced. If the key is active
// (device already activated), the old key is revoked, the device is
// deactivated, and all service credentials are revoked — then a fresh key
// is generated so the user can activate a different device. This is the
// "Regenerate" action in the portal; the old key stops working immediately.
func (h *PortalHandler) GenerateConnectKey(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())
	// The subdomain the user picked during onboarding, if any. Stamp it on the
	// key so that when the device activates with this key, it gets the
	// user's chosen subdomain (not a random device-ID suffix). Independent of
	// custom-domain ownership — the free subdomain is the default address.
	var req struct {
		Subdomain string `json:"subdomain"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	sub := normalizeSubdomain(req.Subdomain)
	if req.Subdomain != "" && sub == "" {
		JSONError(w, http.StatusBadRequest, "Subdomains can only contain letters, numbers, and dashes (3-63 characters).")
		return
	}
	// Reject a subdomain that is already claimed (by another device or a
	// pending key). The availability check counts devices + unused keys; the
	// key stamping must enforce the same rule.
	if sub != "" {
		var taken int
		_ = h.db.QueryRow(`SELECT COUNT(*) FROM devices WHERE subdomain = $1`, sub).Scan(&taken)
		if taken == 0 {
			_ = h.db.QueryRow(`SELECT COUNT(*) FROM connect_keys WHERE subdomain = $1 AND status = 'unused'`, sub).Scan(&taken)
		}
		if taken > 0 {
			JSONError(w, http.StatusConflict, "That subdomain is already taken. Pick another one.")
			return
		}
	}
	// Require verified email before issuing a device activation key
	var emailVerified bool
	_ = h.db.QueryRowContext(r.Context(),
		"SELECT email_verified FROM customer_accounts WHERE id = $1", accountID).Scan(&emailVerified)
	if !emailVerified {
		JSONError(w, http.StatusForbidden, "Please verify your email address before generating a license key. Check your inbox for a verification link, or go to Settings → Security to resend it.")
		return
	}

	// Check if the account already has a key
	var existingKey, existingID, existingPlanID, existingStatus string
	err := h.db.QueryRowContext(r.Context(),
		`SELECT key_prefix || '…', id, plan_id, status FROM connect_keys WHERE account_id = $1`,
		accountID).Scan(&existingKey, &existingID, &existingPlanID, &existingStatus)

	if err == nil {
		// Key already exists. For unused/revoked keys, delete and regenerate.
		// For active keys (device already activated), revoke the key and
		// deactivate the device so the user can activate a new device —
		// this is the "Regenerate" path. All service credentials are
		// revoked so stale connected states don't persist on the old device.
		if existingStatus == "active" {
			var deviceID string
			_ = h.db.QueryRowContext(r.Context(),
				"SELECT id FROM devices WHERE connect_key_id = $1 AND is_active = TRUE", existingID,
			).Scan(&deviceID)
			if deviceID != "" {
				_, _ = h.db.ExecContext(r.Context(), "UPDATE devices SET is_active = FALSE WHERE id = $1", deviceID)
				_, _ = h.db.ExecContext(r.Context(), "UPDATE subscriptions SET status = 'cancelled' WHERE device_id = $1", deviceID)
				_, _ = h.db.ExecContext(r.Context(),
					"UPDATE service_credentials SET is_active = FALSE, revoked_at = $1 WHERE device_id = $2",
					time.Now(), deviceID)
			}
		}
		_, _ = h.db.ExecContext(r.Context(), "DELETE FROM connect_keys WHERE id = $1", existingID)
	}

	// Get the account's current plan
	var planID string
	_ = h.db.QueryRowContext(r.Context(),
		"SELECT plan_id FROM customer_accounts WHERE id = $1", accountID).Scan(&planID)
	if planID == "" {
		planID = "free"
	}

	// Generate a human-readable Connect key: XXXX-XXXX-XXXX-XXXX
	key := security.GenerateConnectKey()
	keyHash := hashToken(key)
	keyPrefix := key[:8]

	connectKeyID := security.GenerateID("lic")
	_, err = h.db.ExecContext(r.Context(),
		`INSERT INTO connect_keys (id, key_hash, key_prefix, account_id, plan_id, subdomain, status)
		 VALUES ($1, $2, $3, $4, $5, $6, 'unused')`,
		connectKeyID, keyHash, keyPrefix, accountID, planID, sql.NullString{String: sub, Valid: sub != ""})
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not generate Connect key")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"connect_key": key,
		"key_id":      connectKeyID,
		"plan_id":     planID,
		"plan_name":   catalog.PlanName(planID),
		"message":     "Enter this key on your LibreServ device to activate Connect.",
	})
}

// GetConnectKeys returns all Connect keys for the authenticated account.
func (h *PortalHandler) GetConnectKeys(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	rows, err := h.db.QueryContext(r.Context(),
		`SELECT lk.id, lk.key_prefix, lk.plan_id, lk.status, lk.created_at, lk.activated_at,
		        d.id, d.is_active
		 FROM connect_keys lk
		 LEFT JOIN devices d ON lk.device_id = d.id
		 WHERE lk.account_id = $1
		 ORDER BY lk.created_at DESC`, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve Connect keys")
		return
	}
	defer rows.Close()

	keys := []map[string]any{}
	for rows.Next() {
		var lk struct {
			ID           string
			KeyPrefix    string
			PlanID       string
			Status       string
			CreatedAt    time.Time
			ActivatedAt  sql.NullTime
			DeviceID     sql.NullString
			DeviceActive sql.NullBool
		}
		_ = rows.Scan(&lk.ID, &lk.KeyPrefix, &lk.PlanID, &lk.Status, &lk.CreatedAt, &lk.ActivatedAt, &lk.DeviceID, &lk.DeviceActive)
		entry := map[string]any{
			"id":         lk.ID,
			"key_prefix": lk.KeyPrefix + "...",
			"plan_id":    lk.PlanID,
			"plan_name":  catalog.PlanName(lk.PlanID),
			"status":     lk.Status,
			"created_at": lk.CreatedAt.Format(time.RFC3339),
		}
		if lk.ActivatedAt.Valid {
			entry["activated_at"] = lk.ActivatedAt.Time.Format(time.RFC3339)
		}
		if lk.DeviceID.Valid {
			entry["device_id"] = lk.DeviceID.String
			entry["device_active"] = lk.DeviceActive.Bool
		}
		keys = append(keys, entry)
	}

	JSON(w, http.StatusOK, map[string]any{"connect_keys": keys})
}

// RevokeConnectKey revokes a Connect key.
func (h *PortalHandler) RevokeConnectKey(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var req struct {
		KeyID string `json:"key_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.KeyID == "" {
		JSONError(w, http.StatusBadRequest, "key_id required")
		return
	}

	_, err := h.db.ExecContext(r.Context(),
		"UPDATE connect_keys SET status = 'revoked' WHERE id = $1 AND account_id = $2 AND status != 'revoked'",
		req.KeyID, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not revoke Connect key")
		return
	}

	JSON(w, http.StatusOK, map[string]string{"message": "Connect key revoked"})
}

// GetDevices returns all devices linked to the authenticated account.
func (h *PortalHandler) GetDevices(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	rows, err := h.db.QueryContext(r.Context(),
		`SELECT id, plan_id, activated_at, last_seen_at, is_active FROM devices WHERE account_id = $1 ORDER BY activated_at DESC`,
		accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not get devices")
		return
	}
	defer rows.Close()

	devices := []map[string]any{}
	for rows.Next() {
		var d struct {
			ID          string
			PlanID      string
			ActivatedAt time.Time
			LastSeenAt  sql.NullTime
			IsActive    bool
		}
		_ = rows.Scan(&d.ID, &d.PlanID, &d.ActivatedAt, &d.LastSeenAt, &d.IsActive)

		// Domain info for the generic domain page: the plan's subdomain and,
		// if a custom domain is active, which one is currently serving.
		subRaw, subdomain := h.domainCoord.DeviceSubdomain(d.ID)
		current, isCustom, _ := h.domainCoord.ServingDomain(d.ID)
		var customDomain *string
		if isCustom {
			customDomain = &current
		}
		hasCustom := isCustom

		devices = append(devices, map[string]any{
			"id":                d.ID,
			"plan_id":           d.PlanID,
			"plan_name":         catalog.PlanName(d.PlanID),
			"activated_at":      d.ActivatedAt.Format(time.RFC3339),
			"last_seen_at":      nullTime(d.LastSeenAt),
			"is_active":         d.IsActive,
			"current_domain":    current,
			"subdomain_raw":     subRaw,
			"subdomain_host":    subdomain,
			"custom_domain":     customDomain,
			"has_custom_domain": hasCustom,
			"plan_domain":       h.planDomain(d.PlanID),
		})
	}

	JSON(w, http.StatusOK, map[string]any{"devices": devices})
}

// planDomain returns the plan's subdomain wildcard pattern, e.g.
// "*.free.servers.libreloom.org" (free) or "*.servers.libreloom.org" (paid).
func (h *PortalHandler) planDomain(planID string) string {
	plan := catalog.PlanByID(planID)
	if plan == nil {
		plan = catalog.PlanByID("free")
	}
	return plan.Limits.Domain
}

// GetPlans returns the public plan catalog.
func (h *PortalHandler) GetPlans(w http.ResponseWriter, r *http.Request) {
	plans := catalog.Plans()
	result := make([]map[string]any, 0, len(plans))
	for _, p := range plans {
		result = append(result, map[string]any{
			"id":            p.ID,
			"name":          p.Name,
			"description":   p.Description,
			"price_monthly": p.PriceMonthlyCents,
			"limits":        p.Limits,
		})
	}
	JSON(w, http.StatusOK, map[string]any{"plans": result})
}

// GetUsage returns usage for the authenticated account's devices.
func (h *PortalHandler) GetUsage(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var deviceID string
	err := h.db.QueryRowContext(r.Context(),
		"SELECT id FROM devices WHERE account_id = $1 AND is_active = TRUE LIMIT 1", accountID).Scan(&deviceID)
	if err == sql.ErrNoRows {
		JSON(w, http.StatusOK, map[string]any{"message": "no devices linked to this account"})
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve usage")
		return
	}

	summary, err := h.billing.GetUsageSummary(deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve usage")
		return
	}

	balance, _ := h.billing.GetBalance(deviceID)

	JSON(w, http.StatusOK, map[string]any{
		"device_id":            summary.DeviceID,
		"plan_id":              summary.PlanID,
		"current_cycle_start":  summary.CycleStart,
		"current_cycle_end":    summary.CycleEnd,
		"total_cost_usd":       summary.TotalCostUSD,
		"provider_cost_usd":    summary.ProviderCostUSD,
		"credits_used":         summary.CreditsUsed,
		"credit_balance_cents": balance,
		"by_service":           summary.ByService,
	})
}

// GetBilling returns billing info for the authenticated account.
func (h *PortalHandler) GetBilling(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var deviceID string
	err := h.db.QueryRowContext(r.Context(),
		"SELECT id FROM devices WHERE account_id = $1 AND is_active = TRUE LIMIT 1", accountID).Scan(&deviceID)
	if err == sql.ErrNoRows {
		JSON(w, http.StatusOK, map[string]any{
			"credit_balance_cents": 0,
			"invoices":             []any{},
			"transactions":         []any{},
		})
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve billing")
		return
	}

	balance, _ := h.billing.GetBalance(deviceID)

	rows, err := h.db.QueryContext(r.Context(),
		`SELECT id, stripe_invoice_id, status, amount_cents, period_start, period_end, created_at, paid_at
		 FROM invoices WHERE device_id = $1 ORDER BY created_at DESC LIMIT 12`, deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve billing")
		return
	}
	defer rows.Close()

	invoices := []map[string]any{}
	for rows.Next() {
		var inv struct {
			ID              string
			StripeInvoiceID sql.NullString
			Status          string
			AmountCents     int
			PeriodStart     time.Time
			PeriodEnd       time.Time
			CreatedAt       time.Time
			PaidAt          sql.NullTime
		}
		_ = rows.Scan(&inv.ID, &inv.StripeInvoiceID, &inv.Status, &inv.AmountCents,
			&inv.PeriodStart, &inv.PeriodEnd, &inv.CreatedAt, &inv.PaidAt)
		invoices = append(invoices, map[string]any{
			"id":                inv.ID,
			"stripe_invoice_id": nullString(inv.StripeInvoiceID),
			"status":            inv.Status,
			"amount_cents":      inv.AmountCents,
			"period_start":      inv.PeriodStart.Format(time.RFC3339),
			"period_end":        inv.PeriodEnd.Format(time.RFC3339),
			"created_at":        inv.CreatedAt.Format(time.RFC3339),
			"paid_at":           nullTime(inv.PaidAt),
		})
	}

	txRows, err := h.db.QueryContext(r.Context(),
		`SELECT amount_cents, direction, reason, created_at FROM credit_transactions
		 WHERE device_id = $1 ORDER BY created_at DESC LIMIT 20`, deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve transactions")
		return
	}
	defer txRows.Close()

	transactions := []map[string]any{}
	for txRows.Next() {
		var tx struct {
			AmountCents int
			Direction   string
			Reason      string
			CreatedAt   time.Time
		}
		_ = txRows.Scan(&tx.AmountCents, &tx.Direction, &tx.Reason, &tx.CreatedAt)
		transactions = append(transactions, map[string]any{
			"amount_cents": tx.AmountCents,
			"direction":    tx.Direction,
			"reason":       tx.Reason,
			"created_at":   tx.CreatedAt.Format(time.RFC3339),
		})
	}

	JSON(w, http.StatusOK, map[string]any{
		"credit_balance_cents": balance,
		"invoices":             invoices,
		"transactions":         transactions,
		"subscription":         h.activeSubscriptionInfo(r.Context(), deviceID),
	})
}

// activeSubscriptionInfo returns the device's active subscription state for the
// billing page: plan, whether it's scheduled to cancel at period end, and when.
func (h *PortalHandler) activeSubscriptionInfo(ctx context.Context, deviceID string) map[string]any {
	var planID, status string
	var cancelAtPeriodEnd bool
	err := h.db.QueryRowContext(ctx,
		`SELECT plan_id, status, cancel_at_period_end FROM subscriptions WHERE device_id = $1 AND status = 'active'`,
		deviceID).Scan(&planID, &status, &cancelAtPeriodEnd)
	if err != nil {
		return map[string]any{"status": "none"}
	}
	info := map[string]any{
		"plan_id":              planID,
		"plan_name":            catalog.PlanName(planID),
		"status":               status,
		"cancel_at_period_end": cancelAtPeriodEnd,
	}
	if cancelAtPeriodEnd {
		info["period_end"] = billingCycleEnd().Format(time.RFC3339)
	}
	return info
}

// Subscribe creates a subscription for a device.
func (h *PortalHandler) Subscribe(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())
	var req struct {
		PlanID   string `json:"plan_id"`
		DeviceID string `json:"device_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.PlanID == "" {
		JSONError(w, http.StatusBadRequest, "plan_id required")
		return
	}

	if catalog.PlanByID(req.PlanID) == nil {
		JSONError(w, http.StatusBadRequest, "invalid plan")
		return
	}

	deviceID := req.DeviceID
	if deviceID == "" {
		err := h.db.QueryRowContext(r.Context(),
			"SELECT id FROM devices WHERE account_id = $1 AND is_active = TRUE LIMIT 1", accountID).Scan(&deviceID)
		if err != nil {
			JSONError(w, http.StatusBadRequest, "no device linked to your account")
			return
		}
	}

	_, err := h.db.ExecContext(r.Context(),
		`INSERT INTO subscriptions (id, device_id, plan_id, status, started_at)
		 VALUES ($1, $2, $3, 'active', $4)
		 ON CONFLICT(device_id) DO UPDATE SET plan_id = excluded.plan_id, status = 'active', started_at = excluded.started_at`,
		security.GenerateID("sub"), deviceID, req.PlanID, time.Now())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not subscribe")
		return
	}

	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE devices SET plan_id = $1 WHERE id = $2", req.PlanID, deviceID)

	JSON(w, http.StatusOK, map[string]any{
		"message":   "subscription created",
		"plan_id":   req.PlanID,
		"plan_name": catalog.PlanName(req.PlanID),
	})
}

// Cancel cancels the device's subscription.
// If Stripe is enabled, cancels the subscription on Stripe's side (immediate).
// Cancel schedules the subscription to end at the close of the current billing
// cycle (cancel_at_period_end on Stripe). The device keeps paid features until
// then; Stripe fires customer.subscription.deleted at period end and the
// webhook performs the downgrade to Free.
func (h *PortalHandler) Cancel(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var deviceID string
	err := h.db.QueryRowContext(r.Context(),
		"SELECT id FROM devices WHERE account_id = $1 AND is_active = TRUE LIMIT 1", accountID).Scan(&deviceID)
	if err != nil {
		JSONError(w, http.StatusBadRequest, "no device linked to your account")
		return
	}

	// On Stripe: mark the subscription to cancel at period end (not immediately).
	if config.C.Stripe.Enabled {
		var stripeSubID string
		_ = h.db.QueryRowContext(r.Context(),
			"SELECT stripe_subscription_id FROM subscriptions WHERE device_id = $1 AND status = 'active'",
			deviceID).Scan(&stripeSubID)
		if stripeSubID != "" {
			if err := providers.SetCancelAtPeriodEnd(r.Context(), stripeSubID, true); err != nil {
				JSONError(w, http.StatusInternalServerError, "could not schedule cancellation with Stripe")
				return
			}
		}
	}

	// Flag locally — the subscription stays active until the cycle closes.
	_, err = h.db.ExecContext(r.Context(),
		"UPDATE subscriptions SET cancel_at_period_end = TRUE WHERE device_id = $1 AND status = 'active'",
		deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not schedule cancellation")
		return
	}

	cycleEnd := billingCycleEnd()
	JSON(w, http.StatusOK, map[string]any{
		"message":    "Your subscription will end at the close of the current billing cycle.",
		"period_end": cycleEnd.Format(time.RFC3339),
	})
}

// ResumeSubscription clears a scheduled cancellation (cancel_at_period_end),
// keeping the subscription active. Idempotent.
func (h *PortalHandler) ResumeSubscription(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var deviceID string
	err := h.db.QueryRowContext(r.Context(),
		"SELECT id FROM devices WHERE account_id = $1 AND is_active = TRUE LIMIT 1", accountID).Scan(&deviceID)
	if err != nil {
		JSONError(w, http.StatusBadRequest, "no device linked to your account")
		return
	}

	if config.C.Stripe.Enabled {
		var stripeSubID string
		_ = h.db.QueryRowContext(r.Context(),
			"SELECT stripe_subscription_id FROM subscriptions WHERE device_id = $1 AND status = 'active'",
			deviceID).Scan(&stripeSubID)
		if stripeSubID != "" {
			if err := providers.SetCancelAtPeriodEnd(r.Context(), stripeSubID, false); err != nil {
				JSONError(w, http.StatusInternalServerError, "could not resume subscription with Stripe")
				return
			}
		}
	}

	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE subscriptions SET cancel_at_period_end = FALSE WHERE device_id = $1 AND status = 'active'",
		deviceID)

	JSON(w, http.StatusOK, map[string]string{"message": "subscription resumed"})
}

// billingCycleEnd returns the end of the current calendar billing cycle
// (last instant of the month), matching GetUsageSummary's cycle computation.
func billingCycleEnd() time.Time {
	now := time.Now()
	start := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, now.Location())
	return start.AddDate(0, 1, -1)
}

// ChangePlan changes the device's subscription plan.
// If Stripe is enabled, updates the price on Stripe's side.
// For upgrades from free to paid, creates a new checkout session instead.
func (h *PortalHandler) ChangePlan(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())
	var req struct {
		PlanID   string `json:"plan_id"`
		DeviceID string `json:"device_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.PlanID == "" {
		JSONError(w, http.StatusBadRequest, "plan_id required")
		return
	}

	if catalog.PlanByID(req.PlanID) == nil {
		JSONError(w, http.StatusBadRequest, "invalid plan")
		return
	}

	deviceID := req.DeviceID
	if deviceID == "" {
		err := h.db.QueryRowContext(r.Context(),
			"SELECT id FROM devices WHERE account_id = $1 AND is_active = TRUE LIMIT 1", accountID).Scan(&deviceID)
		if err != nil {
			JSONError(w, http.StatusBadRequest, "no device linked to your account")
			return
		}
	}

	// If the target plan is paid and Stripe is enabled, we need a checkout session
	// (either for a new subscription or an upgrade from free)
	if catalog.IsPaidPlan(req.PlanID) && config.C.Stripe.Enabled {
		var stripeSubID string
		_ = h.db.QueryRowContext(r.Context(),
			"SELECT stripe_subscription_id FROM subscriptions WHERE device_id = $1 AND status = 'active'",
			deviceID).Scan(&stripeSubID)

		if stripeSubID != "" {
			// Existing paid subscription — update the price on Stripe
			newPriceID := planToPrice(req.PlanID)
			if err := providers.UpdateSubscriptionPrice(r.Context(), stripeSubID, newPriceID); err != nil {
				JSONError(w, http.StatusInternalServerError, "could not change plan with Stripe")
				return
			}
		} else {
			// No existing Stripe subscription — redirect to checkout.
			// Reconstruct the request body: ChangePlan already consumed it,
			// and CreateCheckoutSession decodes it again.
			body, _ := json.Marshal(map[string]string{
				"plan_id":   req.PlanID,
				"device_id": req.DeviceID,
			})
			r.Body = io.NopCloser(bytes.NewReader(body))
			h.CreateCheckoutSession(w, r)
			return
		}
	}

	_, err := h.db.ExecContext(r.Context(),
		`UPDATE subscriptions SET plan_id = $1, started_at = $2 WHERE device_id = $3 AND status = 'active'`,
		req.PlanID, time.Now(), deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not change plan")
		return
	}

	_, _ = h.db.ExecContext(r.Context(),
		"UPDATE devices SET plan_id = $1 WHERE id = $2", req.PlanID, deviceID)

	// If downgrading to Free, put any active custom domain into grace.
	if req.PlanID == "free" {
		h.handleDomainGraceOnDowngrade(r.Context(), deviceID)
	} else {
		// Upgrade or lateral move — re-provision subdomain only if no custom domain.
		h.reprovisionSubdomainIfNoCustomDomain(r.Context(), deviceID)
	}

	// Reconcile the device's domain state (custom → tunnel/DNS/credentials,
	// or subdomain fallback). Best-effort; scheduler re-runs.
	h.domainCoord.Reconcile(deviceID)

	JSON(w, http.StatusOK, map[string]any{
		"message":   "plan changed",
		"plan_id":   req.PlanID,
		"plan_name": catalog.PlanName(req.PlanID),
	})
}

// RespondConsent allows a customer to approve or deny a consent request.
func (h *PortalHandler) RespondConsent(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	consentID := r.URL.Query().Get("id")
	if consentID == "" {
		// Try to extract from path
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) >= 3 {
			consentID = parts[2]
		}
	}
	if consentID == "" {
		JSONError(w, http.StatusBadRequest, "consent id required")
		return
	}

	var req struct {
		Decision string `json:"decision"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || (req.Decision != "granted" && req.Decision != "denied") {
		JSONError(w, http.StatusBadRequest, "decision must be 'granted' or 'denied'")
		return
	}

	var deviceID string
	err := h.db.QueryRowContext(r.Context(),
		`SELECT cr.device_id FROM consent_requests cr
		 JOIN devices d ON cr.device_id = d.id
		 WHERE cr.id = $1 AND d.account_id = $2`, consentID, accountID).Scan(&deviceID)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "consent request not found")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not verify consent request")
		return
	}

	_, err = h.db.ExecContext(r.Context(),
		`UPDATE consent_requests SET status = $1, responded_at = $2 WHERE id = $3 AND status = 'pending'`,
		req.Decision, time.Now(), consentID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not respond to consent request")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message": "consent " + req.Decision,
		"status":  req.Decision,
	})
}

// GetConsentRequests returns pending consent requests for the account's devices.
func (h *PortalHandler) GetConsentRequests(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	rows, err := h.db.QueryContext(r.Context(),
		`SELECT cr.id, cr.case_id, cr.path, cr.scope_type, cr.status, cr.requested_at, cr.expires_at, cr.notes
		 FROM consent_requests cr
		 JOIN devices d ON cr.device_id = d.id
		 WHERE d.account_id = $1 AND cr.status = 'pending'
		 ORDER BY cr.requested_at DESC`, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not retrieve consent requests")
		return
	}
	defer rows.Close()

	requests := []map[string]any{}
	for rows.Next() {
		var cr struct {
			ID          string
			CaseID      string
			Path        string
			ScopeType   string
			Status      string
			RequestedAt time.Time
			ExpiresAt   sql.NullTime
			Notes       sql.NullString
		}
		_ = rows.Scan(&cr.ID, &cr.CaseID, &cr.Path, &cr.ScopeType, &cr.Status, &cr.RequestedAt, &cr.ExpiresAt, &cr.Notes)
		requests = append(requests, map[string]any{
			"id":           cr.ID,
			"case_id":      cr.CaseID,
			"path":         cr.Path,
			"scope_type":   cr.ScopeType,
			"status":       cr.Status,
			"requested_at": cr.RequestedAt.Format(time.RFC3339),
			"expires_at":   nullTime(cr.ExpiresAt),
			"notes":        nullString(cr.Notes),
		})
	}

	JSON(w, http.StatusOK, map[string]any{"consent_requests": requests})
}

// CreateCheckoutSession creates a Stripe Checkout session for subscribing to a plan.
// The user is redirected to Stripe's hosted checkout page. After payment, Stripe
// sends a webhook to our /webhooks/stripe endpoint, which records the subscription.
func (h *PortalHandler) CreateCheckoutSession(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	var req struct {
		PlanID   string `json:"plan_id"`
		DeviceID string `json:"device_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.PlanID == "" {
		JSONError(w, http.StatusBadRequest, "plan_id required")
		return
	}

	plan := catalog.PlanByID(req.PlanID)
	if plan == nil {
		JSONError(w, http.StatusBadRequest, "invalid plan")
		return
	}

	if !catalog.IsPaidPlan(req.PlanID) || !config.C.Stripe.Enabled {
		// Free plan, or Stripe not configured — set the plan on the account
		// directly. During onboarding there may be no device yet, so we update
		// customer_accounts.plan_id (which GenerateConnectKey reads to stamp
		// the plan onto the Connect key) instead of calling Subscribe (which
		// requires a device and would re-decode the already-consumed body).
		_, err := h.db.ExecContext(r.Context(),
			"UPDATE customer_accounts SET plan_id = $1 WHERE id = $2",
			req.PlanID, accountID)
		if err != nil {
			JSONError(w, http.StatusInternalServerError, "could not set plan")
			return
		}
		JSON(w, http.StatusOK, map[string]any{
			"checkout_url": "#",
			"plan_id":      req.PlanID,
		})
		return
	}

	// Get Stripe price ID for the plan
	priceID := planToPrice(req.PlanID)
	if priceID == "" {
		JSONError(w, http.StatusInternalServerError, "stripe price not configured for this plan")
		return
	}

	// Determine the reference ID to link this checkout to. In the
	// one-server-per-account model, account_id is the primary key — use it
	// when no device is active yet.
	refID := req.DeviceID
	if refID == "" {
		_ = h.db.QueryRowContext(r.Context(),
			"SELECT id FROM devices WHERE account_id = $1 AND is_active = TRUE LIMIT 1", accountID).Scan(&refID)
		if refID == "" {
			refID = accountID // no device yet — link to the account
		}
	}

	successURL := config.C.Server.BaseURL + "/onboarding?checkout=success"
	cancelURL := config.C.Server.BaseURL + "/onboarding?checkout=cancelled"

	checkoutURL, err := providers.CreateCheckoutSession(r.Context(), priceID, refID, successURL, cancelURL)
	if err != nil {
		slog.Error("failed to create Stripe checkout session", "error", err, "plan", req.PlanID, "account", accountID)
		JSONError(w, http.StatusInternalServerError, "could not create checkout session")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"checkout_url": checkoutURL,
		"plan_id":      req.PlanID,
	})
}

// BillingPortal creates a Stripe billing portal session for subscription management.
// This lets customers update their payment method, cancel, or change plans on Stripe's site.
func (h *PortalHandler) BillingPortal(w http.ResponseWriter, r *http.Request) {
	if !config.C.Stripe.Enabled {
		JSON(w, http.StatusOK, map[string]any{
			"portal_url": "/billing",
			"message":    "Manage your subscription from the Billing page.",
		})
		return
	}

	// Stripe billing portal requires a customer ID.
	// For now, return our own billing page — the customer can cancel/change plans here.
	JSON(w, http.StatusOK, map[string]any{
		"portal_url": "/billing",
		"message":    "Manage your subscription from the Billing page. Cancel or change plans here.",
	})
}

// lookUpTunnelCredentials queries the service_providers table for the enabled tunnel provider
// and returns the API token and account ID extracted from the JSON columns.
func (h *PortalHandler) lookUpTunnelCredentials(r *http.Request) (apiToken, accountID string, err error) {
	var credentialsJSON, settingsJSON sql.NullString
	err = h.db.QueryRowContext(r.Context(),
		`SELECT credentials_json, settings_json FROM service_providers WHERE service = 'tunnel' AND enabled = TRUE LIMIT 1`,
	).Scan(&credentialsJSON, &settingsJSON)
	if err != nil {
		return "", "", fmt.Errorf("no tunnel provider configured")
	}
	var creds map[string]any
	json.Unmarshal([]byte(credentialsJSON.String), &creds)
	if t, ok := creds["api_token"].(string); ok {
		apiToken = t
	}
	var settings map[string]any
	json.Unmarshal([]byte(settingsJSON.String), &settings)
	if a, ok := settings["account_id"].(string); ok {
		accountID = a
	}
	return apiToken, accountID, nil
}

// SearchDomains searches for available domains matching a query.
func (h *PortalHandler) SearchDomains(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Query string `json:"query"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Query == "" {
		JSONError(w, http.StatusBadRequest, "query is required")
		return
	}

	if config.C.Purchase.MockDomain {
		q := strings.ToLower(strings.TrimSpace(req.Query))
		JSON(w, http.StatusOK, map[string]any{"domains": mockDomainResults(q)})
		return
	}

	apiToken, accountID, err := h.lookUpTunnelCredentials(r)
	if err != nil {
		JSONError(w, http.StatusBadGateway, "Cloudflare tunnel provider is not configured. Please set it up from the Admin panel.")
		return
	}

	results, err := h.registrar.SearchDomains(accountID, apiToken, req.Query, 5)
	if err != nil {
		JSONError(w, http.StatusBadGateway, fmt.Sprintf("could not search domains: %s", err.Error()))
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"domains": results,
	})
}

// mockDomainResults returns realistic-looking domain suggestions for mock
// mode, so the search/check/register flow can be walked without a real
// registrar. Names look like what a registrar would return (query + common
// TLDs). No `available` field is set — the Check step populates that and the
// price, exercising the same UI states as the real flow.
func mockDomainResults(base string) []map[string]any {
	base = strings.ToLower(strings.ReplaceAll(strings.TrimSpace(base), " ", ""))
	if base == "" {
		base = "mysite"
	}

	type candidate struct{ name, price string }
	var cands []candidate
	if strings.Contains(base, ".") {
		// Query already looks like a full domain — echo it back plus one variant.
		cands = []candidate{
			{base, "11.20"},
		}
	} else {
		cands = []candidate{
			{base + ".com", "11.20"},
			{base + ".net", "11.86"},
			{base + ".io", "32.00"},
			{base + ".dev", "12.50"},
			{base + ".app", "14.00"},
		}
	}

	results := make([]map[string]any, 0, len(cands))
	for _, c := range cands {
		results = append(results, map[string]any{
			"name":              c.name,
			"registration_cost": c.price,
		})
	}
	return results
}

// CheckDomain checks real-time availability and pricing for a specific domain.
func (h *PortalHandler) CheckDomain(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Domain string `json:"domain"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Domain == "" {
		JSONError(w, http.StatusBadRequest, "domain is required")
		return
	}

	if config.C.Purchase.MockDomain {
		JSON(w, http.StatusOK, map[string]any{
			"domain":            req.Domain,
			"registrable":       true,
			"available":         true,
			"registration_cost": "11.20",
			"renewal_cost":      "11.20",
		})
		return
	}

	apiToken, accountID, err := h.lookUpTunnelCredentials(r)
	if err != nil {
		JSONError(w, http.StatusBadGateway, "Cloudflare tunnel provider is not configured. Please set it up from the Admin panel.")
		return
	}

	result, err := h.registrar.CheckDomain(accountID, apiToken, req.Domain)
	if err != nil {
		JSONError(w, http.StatusBadGateway, fmt.Sprintf("could not check domain: %s", err.Error()))
		return
	}

	JSON(w, http.StatusOK, result)
}

// RegisterDomain creates a Stripe checkout session for purchasing a domain.
// The domain is registered via Cloudflare Registrar after payment succeeds (webhook).
// This charges the user at-cost via Stripe — no markup on the registration price.
// In mock mode, domains can be registered without a device — the domain is owned
// at the account level and can be assigned to a device later.
func (h *PortalHandler) RegisterDomain(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())
	var req struct {
		DeviceID string `json:"device_id"`
		Domain   string `json:"domain"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Domain == "" {
		JSONError(w, http.StatusBadRequest, "domain is required")
		return
	}

	// Mock mode: register the domain directly, no Stripe payment and no real
	// Cloudflare registration, so the whole purchase flow can be walked. Works
	// with or without a device_id — the domain is owned at the account level.
	if config.C.Purchase.MockDomain {
		deviceID := req.DeviceID
		if deviceID == "" {
			// Look up the account's existing device.
			err := h.db.QueryRowContext(r.Context(),
				`SELECT id FROM devices WHERE account_id = $1 LIMIT 1`,
				accountID).Scan(&deviceID)
			if err != nil {
				deviceID = "" // no device — domain is account-level only
			}
		}
		h.registerDomainInDB(deviceID, accountID, req.Domain, 1120, 1120)
		JSON(w, http.StatusOK, map[string]any{
			"domain": req.Domain,
			"status": "registered",
			"mock":   true,
		})
		return
	}

	// Real mode requires a device_id to link the domain to.
	if req.DeviceID == "" {
		JSONError(w, http.StatusBadRequest, "device_id and domain are required")
		return
	}

	// Verify the device belongs to the authenticated account.
	var devAccountID string
	err := h.db.QueryRowContext(r.Context(),
		`SELECT account_id FROM devices WHERE id = $1`, req.DeviceID,
	).Scan(&devAccountID)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "device not found")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not verify device")
		return
	}
	if devAccountID == "" {
		JSONError(w, http.StatusBadRequest, "device is not linked to an account")
		return
	}
	if devAccountID != accountID {
		JSONError(w, http.StatusForbidden, "you can only register domains for your own devices")
		return
	}

	// Check domain availability and get the at-cost price from Cloudflare Registrar
	apiToken, cfAccountID, err := h.lookUpTunnelCredentials(r)
	if err != nil {
		JSONError(w, http.StatusBadGateway, "Cloudflare provider is not configured. Please set it up from the Admin panel.")
		return
	}

	domainInfo, err := h.registrar.CheckDomain(cfAccountID, apiToken, req.Domain)
	if err != nil {
		JSONError(w, http.StatusBadGateway, fmt.Sprintf("could not check domain availability: %s", err.Error()))
		return
	}
	if !domainInfo.Registrable {
		JSONError(w, http.StatusConflict, "This domain is not available for registration.")
		return
	}

	// Parse the registration cost to cents (used in both dev-mode and Stripe paths)
	amountCents, err := parseDomainCostToCents(domainInfo.RegistrationCost)
	if err != nil || amountCents <= 0 {
		JSONError(w, http.StatusInternalServerError, "could not determine domain registration cost")
		return
	}

	// If Stripe is not enabled, register directly (dev mode)
	if !config.C.Stripe.Enabled {
		expiresAt, err := h.registrar.RegisterDomain(cfAccountID, apiToken, req.Domain)
		if err != nil {
			JSONError(w, http.StatusBadGateway, fmt.Sprintf("could not register domain: %s", err.Error()))
			return
		}
		if expiresAt.IsZero() {
			expiresAt = time.Now().AddDate(1, 0, 0)
		}
		var renewalCostCents int64
		if rc, parseErr := parseDomainCostToCents(domainInfo.RenewalCost); parseErr == nil {
			renewalCostCents = rc
		}
		domainID := security.GenerateID("dom")
		_, _ = h.db.ExecContext(r.Context(),
			`INSERT INTO custom_domains (id, device_id, account_id, domain, registered_via, registration_cost_cents, renewal_cost_cents, auto_renew, status, expires_at)
			 VALUES ($1, $2, $3, $4, 'cloudflare', $5, $6, TRUE, 'active', $7)`,
			domainID, req.DeviceID, accountID, req.Domain, int(amountCents), int(renewalCostCents), expiresAt)
		JSON(w, http.StatusOK, map[string]any{
			"domain": req.Domain,
			"status": "registered",
			"id":     domainID,
		})
		return
	}

	// Create a Stripe checkout session for the domain registration (at-cost, one-time payment)
	successURL := config.C.Server.BaseURL + "/domains?domain=success"
	cancelURL := config.C.Server.BaseURL + "/domains?domain=cancelled"

	checkoutURL, err := providers.CreateDomainCheckoutSession(r.Context(), req.DeviceID, accountID, req.Domain, amountCents, successURL, cancelURL)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create checkout session for domain")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"checkout_url":  checkoutURL,
		"domain":        req.Domain,
		"price_cents":   amountCents,
		"price_display": fmt.Sprintf("$%.2f", float64(amountCents)/100),
	})
}

// ListDomains returns custom domains for the authenticated account.
// Domains are owned at the account level, optionally linked to a device.
func (h *PortalHandler) ListDomains(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())

	rows, err := h.db.QueryContext(r.Context(),
		`SELECT cd.id, cd.domain, cd.registered_via, cd.auto_renew, cd.status, cd.purchased_at, cd.expires_at, cd.grace_until, cd.device_id, d.plan_id
		 FROM custom_domains cd
		 LEFT JOIN devices d ON cd.device_id = d.id
		 WHERE cd.account_id = $1`,
		accountID,
	)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not list domains")
		return
	}
	defer rows.Close()

	type domainRow struct {
		ID            string
		Domain        string
		RegisteredVia string
		AutoRenew     bool
		Status        string
		PurchasedAt   time.Time
		ExpiresAt     sql.NullTime
		GraceUntil    sql.NullTime
		DeviceID      sql.NullString
		PlanID        sql.NullString
	}

	var domains []map[string]any
	for rows.Next() {
		var dr domainRow
		if err := rows.Scan(&dr.ID, &dr.Domain, &dr.RegisteredVia, &dr.AutoRenew, &dr.Status, &dr.PurchasedAt, &dr.ExpiresAt, &dr.GraceUntil, &dr.DeviceID, &dr.PlanID); err != nil {
			JSONError(w, http.StatusInternalServerError, "could not parse domain row")
			return
		}
		domains = append(domains, map[string]any{
			"id":             dr.ID,
			"domain":         dr.Domain,
			"registered_via": dr.RegisteredVia,
			"auto_renew":     dr.AutoRenew,
			"status":         dr.Status,
			"purchased_at":   dr.PurchasedAt,
			"expires_at":     dr.ExpiresAt,
			"grace_until":    dr.GraceUntil,
			"device_id":      dr.DeviceID,
			"plan_id":        dr.PlanID,
		})
	}

	JSON(w, http.StatusOK, map[string]any{
		"domains": domains,
	})
}

// parseDomainCostToCents converts a price string like "11.20" to cents (1120).
func parseDomainCostToCents(cost string) (int64, error) {
	amount, err := strconv.ParseFloat(cost, 64)
	if err != nil {
		return 0, fmt.Errorf("invalid cost %q: %w", cost, err)
	}
	return int64(amount * 100), nil
}

// GetDomainDetails returns full status for a specific custom domain.
// Fetches live data from Cloudflare Registrar (expires_at, auto_renew, status)
// and the current at-cost renewal price via CheckDomain.
func (h *PortalHandler) GetDomainDetails(w http.ResponseWriter, r *http.Request) {
	domainName := chi.URLParam(r, "domain")
	if domainName == "" {
		JSONError(w, http.StatusBadRequest, "domain is required")
		return
	}

	accountID := middleware.GetCustomerDeviceID(r.Context())

	// Verify the domain belongs to the authenticated account.
	var deviceID sql.NullString
	var status string
	var autoRenew bool
	var purchasedAt time.Time
	var expiresAt sql.NullTime
	var registrationCostCents, renewalCostCents sql.NullInt64
	err := h.db.QueryRowContext(r.Context(),
		`SELECT cd.device_id, cd.status, cd.auto_renew, cd.purchased_at, cd.expires_at,
		        cd.registration_cost_cents, cd.renewal_cost_cents
		 FROM custom_domains cd
		 WHERE cd.domain = $1 AND cd.account_id = $2`,
		domainName, accountID,
	).Scan(&deviceID, &status, &autoRenew, &purchasedAt, &expiresAt, &registrationCostCents, &renewalCostCents)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "domain not found")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not look up domain")
		return
	}

	// Fetch live data from Cloudflare Registrar.
	apiToken, cfAccountID, credErr := h.lookUpTunnelCredentials(r)
	liveExpiry := expiresAt
	liveAutoRenew := autoRenew
	liveStatus := status
	if credErr == nil {
		if info, err := h.registrar.GetDomain(cfAccountID, apiToken, domainName); err == nil && info != nil {
			if !info.ExpiresAt.IsZero() {
				liveExpiry = sql.NullTime{Time: info.ExpiresAt, Valid: true}
			}
			liveAutoRenew = info.AutoRenew
			liveStatus = info.Status
		}
	}

	// Get the current renewal price (what the user pays at next renewal).
	renewalPriceCents := int64(0)
	if renewalCostCents.Valid {
		renewalPriceCents = renewalCostCents.Int64
	}
	if credErr == nil {
		if di, err := h.registrar.CheckDomain(cfAccountID, apiToken, domainName); err == nil && di != nil {
			if rc, parseErr := parseDomainCostToCents(di.RenewalCost); parseErr == nil && rc > 0 {
				renewalPriceCents = rc
			}
		}
	}

	// Check DNS configuration status.
	dnsConfigured := false
	if deviceID.Valid {
		var credsJSON string
		_ = h.db.QueryRowContext(r.Context(),
			`SELECT credentials_json FROM service_credentials
			 WHERE device_id = $1 AND service_type = 'domain' AND is_active = TRUE`,
			deviceID.String).Scan(&credsJSON)
		if credsJSON != "" {
			var creds map[string]any
			if json.Unmarshal([]byte(credsJSON), &creds) == nil {
				if v, ok := creds["dns_managed"].(bool); ok {
					dnsConfigured = v
				}
			}
		}
	}

	// Compute days until expiry.
	daysUntilExpiry := 0
	if liveExpiry.Valid {
		daysUntilExpiry = int(time.Until(liveExpiry.Time).Hours() / 24)
	}

	regCost := int64(0)
	if registrationCostCents.Valid {
		regCost = registrationCostCents.Int64
	}

	devID := ""
	if deviceID.Valid {
		devID = deviceID.String
	}

	JSON(w, http.StatusOK, map[string]any{
		"domain":                  domainName,
		"status":                  liveStatus,
		"auto_renew":              liveAutoRenew,
		"expires_at":              liveExpiry,
		"days_until_expiry":       daysUntilExpiry,
		"renewal_price_cents":     renewalPriceCents,
		"renewal_price_display":   fmt.Sprintf("$%.2f/year", float64(renewalPriceCents)/100),
		"registration_cost_cents": regCost,
		"purchased_at":            purchasedAt,
		"dns_configured":          dnsConfigured,
		"device_id":               devID,
	})
}

// CancelDomain cancels a custom domain — disables CF auto-renew and sets status='cancelled'.
// The domain keeps routing until expiry (grace). DNS is cleaned up by the scheduler after expiry.
func (h *PortalHandler) CancelDomain(w http.ResponseWriter, r *http.Request) {
	domainName := chi.URLParam(r, "domain")
	if domainName == "" {
		JSONError(w, http.StatusBadRequest, "domain is required")
		return
	}

	accountID := middleware.GetCustomerDeviceID(r.Context())

	// Verify the domain belongs to the authenticated account.
	var deviceID sql.NullString
	var status string
	var expiresAt sql.NullTime
	err := h.db.QueryRowContext(r.Context(),
		`SELECT cd.device_id, cd.status, cd.expires_at
		 FROM custom_domains cd
		 WHERE cd.domain = $1 AND cd.account_id = $2`,
		domainName, accountID,
	).Scan(&deviceID, &status, &expiresAt)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "domain not found")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not look up domain")
		return
	}
	if status == "cancelled" || status == "expired" {
		JSONError(w, http.StatusConflict, "this domain is already cancelled or expired")
		return
	}

	// Disable CF auto-renew so the domain expires naturally.
	apiToken, cfAccountID, credErr := h.lookUpTunnelCredentials(r)
	if credErr != nil {
		JSONError(w, http.StatusBadGateway, "Cloudflare provider is not configured")
		return
	}
	if err := h.registrar.UpdateDomainAutoRenew(cfAccountID, apiToken, domainName, false); err != nil {
		slog.Warn("failed to disable CF auto-renew on cancel", "error", err, "domain", domainName)
	}

	// Update custom_domains status.
	_, _ = h.db.ExecContext(r.Context(),
		`UPDATE custom_domains SET status = 'cancelled', auto_renew = FALSE WHERE domain = $1`,
		domainName)

	// If the domain was the device's serving domain, reconcile the device
	// back onto its plan subdomain (single writer).
	if deviceID.Valid {
		if err := h.domainCoord.Reconcile(deviceID.String); err != nil {
			slog.Warn("failed to reconcile subdomain after domain cancel", "error", err, "device", deviceID.String)
		}
	}

	expiryStr := "unknown"
	if expiresAt.Valid {
		expiryStr = expiresAt.Time.Format(time.RFC3339)
	}

	JSON(w, http.StatusOK, map[string]any{
		"message":    "domain cancelled — it will stop working on the expiry date",
		"domain":     domainName,
		"status":     "cancelled",
		"expires_at": expiryStr,
	})
}

// UseSubdomain switches a device back to its plan-provided subdomain,
// dropping any active custom domain (it enters grace and stops on expiry) and
// re-provisioning the subdomain via the domain service.
// POST /portal/devices/use-subdomain  {device_id}
func (h *PortalHandler) UseSubdomain(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())
	var req struct {
		DeviceID string `json:"device_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.DeviceID == "" {
		JSONError(w, http.StatusBadRequest, "device_id is required")
		return
	}

	// Verify the device belongs to the authenticated account.
	var owner string
	err := h.db.QueryRowContext(r.Context(),
		`SELECT account_id FROM devices WHERE id = $1`, req.DeviceID,
	).Scan(&owner)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "device not found")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not verify device")
		return
	}
	if owner != accountID {
		JSONError(w, http.StatusForbidden, "you can only manage domains for your own devices")
		return
	}

	// Put any active custom domain into grace so it stops renewing/overriding.
	h.handleDomainGraceOnDowngrade(r.Context(), req.DeviceID)

	// Single reconciler: switches the device back to its plan subdomain
	// (revokes the custom domain credential, provisions the subdomain,
	// and updates DNS/ingress).
	if err := h.domainCoord.Reconcile(req.DeviceID); err != nil {
		slog.Warn("failed to reconcile subdomain after switch", "error", err, "device", req.DeviceID)
		JSONError(w, http.StatusInternalServerError, "could not switch to your subdomain. Please try again.")
		return
	}

	subRaw, subdomain := h.domainCoord.DeviceSubdomain(req.DeviceID)
	JSON(w, http.StatusOK, map[string]any{
		"message":   "Switched to your plan's subdomain.",
		"subdomain": subdomain,
		"sub_raw":   subRaw,
	})
}

// CheckSubdomain checks whether a subdomain prefix is available for use.
// Validates format (lowercase alphanumerics + dashes) and checks it isn't
// already claimed by another device.
// POST /portal/devices/check-subdomain  {subdomain: "myalias"}
func (h *PortalHandler) CheckSubdomain(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Subdomain string `json:"subdomain"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Subdomain == "" {
		JSONError(w, http.StatusBadRequest, "subdomain is required")
		return
	}

	sub := normalizeSubdomain(req.Subdomain)
	if sub == "" {
		JSONError(w, http.StatusBadRequest, "Subdomains can only contain letters, numbers, and dashes (3-63 characters).")
		return
	}

	// Uniqueness check (prevent duplicate subdomains) across both devices and
	// pending (unused) Connect keys — a subdomain picked during onboarding is
	// reserved on the key, so it must count as taken.
	var taken int
	_ = h.db.QueryRow(`SELECT COUNT(*) FROM devices WHERE subdomain = $1`, sub).Scan(&taken)
	if taken == 0 {
		_ = h.db.QueryRow(`SELECT COUNT(*) FROM connect_keys WHERE subdomain = $1 AND status = 'unused'`, sub).Scan(&taken)
	}
	JSON(w, http.StatusOK, map[string]any{
		"subdomain": sub,
		"available": taken == 0,
	})
}

// SetSubdomain sets (or changes) a device's subdomain prefix. The new
// subdomain must be unique and the byte must belong to the caller. Re-provisions
// the domain service so DNS reflects the new hostname.
// POST /portal/devices/set-subdomain  {device_id, subdomain}
func (h *PortalHandler) SetSubdomain(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())
	var req struct {
		DeviceID  string `json:"device_id"`
		Subdomain string `json:"subdomain"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.DeviceID == "" || req.Subdomain == "" {
		JSONError(w, http.StatusBadRequest, "device_id and subdomain are required")
		return
	}

	sub := normalizeSubdomain(req.Subdomain)
	if sub == "" {
		JSONError(w, http.StatusBadRequest, "Subdomains can only contain letters, numbers, and dashes (3-63 characters).")
		return
	}

	// Verify the device belongs to the authenticated account.
	var owner string
	err := h.db.QueryRowContext(r.Context(),
		`SELECT account_id FROM devices WHERE id = $1`, req.DeviceID,
	).Scan(&owner)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "device not found")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not verify device")
		return
	}
	if owner != accountID {
		JSONError(w, http.StatusForbidden, "you can only manage domains for your own devices")
		return
	}

	// Uniqueness check (prevent duplicate subdomains).
	var takenID string
	err = h.db.QueryRow(`SELECT id FROM devices WHERE subdomain = $1 AND id != $2`, sub, req.DeviceID).Scan(&takenID)
	if err != sql.ErrNoRows {
		JSONError(w, http.StatusConflict, "That subdomain is already taken. Try another one.")
		return
	}

	// If a custom domain is currently active, the subdomain is not being served
	// yet; that's fine — set it and it takes effect when they switch back.
	if _, err := h.db.Exec(`UPDATE devices SET subdomain = $1 WHERE id = $2`, sub, req.DeviceID); err != nil {
		slog.Error("failed to set subdomain", "error", err, "device", req.DeviceID)
		JSONError(w, http.StatusInternalServerError, "could not set subdomain")
		return
	}

	// Re-provision the domain service so DNS reflects the new hostname.
	// Single reconciler: if a custom domain is active it takes precedence;
	// otherwise the subdomain is provisioned.
	if err := h.domainCoord.Reconcile(req.DeviceID); err != nil {
		slog.Warn("failed to reconcile subdomain on set", "error", err, "device", req.DeviceID)
	}

	full := h.domainCoord.SubdomainHostname(sub, req.DeviceID)
	JSON(w, http.StatusOK, map[string]any{
		"message":        "Subdomain updated.",
		"subdomain_raw":  sub,
		"subdomain_host": full,
	})
}

// normalizeSubdomain validates and normalizes a subdomain prefix.
// Returns "" if invalid.
func normalizeSubdomain(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	if len(s) < 3 || len(s) > 63 {
		return ""
	}
	for _, c := range s {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return ""
		}
	}
	// Leading/trailing dashes are invalid for hostnames.
	if strings.HasPrefix(s, "-") || strings.HasSuffix(s, "-") {
		return ""
	}
	return s
}

// ChangeDomain initiates a domain change: purchases a new domain via the existing
// Stripe checkout flow. The old domain is cancelled automatically when the new
// domain's registration succeeds (in handleDomainPurchase).
func (h *PortalHandler) ChangeDomain(w http.ResponseWriter, r *http.Request) {
	accountID := middleware.GetCustomerDeviceID(r.Context())
	var req struct {
		DeviceID  string `json:"device_id"`
		NewDomain string `json:"new_domain"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.DeviceID == "" || req.NewDomain == "" {
		JSONError(w, http.StatusBadRequest, "device_id and new_domain are required")
		return
	}

	// Verify the device belongs to the authenticated account.
	var devAccountID string
	err := h.db.QueryRowContext(r.Context(),
		`SELECT account_id FROM devices WHERE id = $1`, req.DeviceID,
	).Scan(&devAccountID)
	if err == sql.ErrNoRows {
		JSONError(w, http.StatusNotFound, "device not found")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not verify device")
		return
	}
	if devAccountID != accountID {
		JSONError(w, http.StatusForbidden, "you can only change domains for your own devices")
		return
	}

	// Mock mode: replace any existing registered domain and activate the new one.
	if config.C.Purchase.MockDomain {
		h.registerDomainInDB(req.DeviceID, accountID, req.NewDomain, 1120, 1120)
		JSON(w, http.StatusOK, map[string]any{
			"domain": req.NewDomain,
			"status": "registered",
			"mock":   true,
		})
		return
	}

	// Check domain availability and get the at-cost price.
	apiToken, cfAccountID, err := h.lookUpTunnelCredentials(r)
	if err != nil {
		JSONError(w, http.StatusBadGateway, "Cloudflare provider is not configured. Please set it up from the Admin panel.")
		return
	}
	domainInfo, err := h.registrar.CheckDomain(cfAccountID, apiToken, req.NewDomain)
	if err != nil {
		JSONError(w, http.StatusBadGateway, fmt.Sprintf("could not check domain availability: %s", err.Error()))
		return
	}
	if !domainInfo.Registrable {
		JSONError(w, http.StatusConflict, "This domain is not available for registration.")
		return
	}

	amountCents, err := parseDomainCostToCents(domainInfo.RegistrationCost)
	if err != nil || amountCents <= 0 {
		JSONError(w, http.StatusInternalServerError, "could not determine domain registration cost")
		return
	}

	// If Stripe is not enabled, register directly (dev mode).
	if !config.C.Stripe.Enabled {
		expiresAt, err := h.registrar.RegisterDomain(cfAccountID, apiToken, req.NewDomain)
		if err != nil {
			JSONError(w, http.StatusBadGateway, fmt.Sprintf("could not register domain: %s", err.Error()))
			return
		}
		if expiresAt.IsZero() {
			expiresAt = time.Now().AddDate(1, 0, 0)
		}
		var renewalCostCents int64
		if rc, parseErr := parseDomainCostToCents(domainInfo.RenewalCost); parseErr == nil {
			renewalCostCents = rc
		}

		// Cancel the old domain if one exists.
		h.cancelExistingDomain(r.Context(), req.DeviceID, apiToken, cfAccountID)

		domainID := security.GenerateID("dom")
		_, _ = h.db.ExecContext(r.Context(),
			`INSERT INTO custom_domains (id, device_id, account_id, domain, registered_via, registration_cost_cents, renewal_cost_cents, auto_renew, status, expires_at)
			 VALUES ($1, $2, $3, $4, 'cloudflare', $5, $6, TRUE, 'active', $7)`,
			domainID, req.DeviceID, accountID, req.NewDomain, int(amountCents), int(renewalCostCents), expiresAt)
		// Apply the new domain as serving (DNS/ingress/credentials) via the
		// single reconciler.
		if err := h.domainCoord.Reconcile(req.DeviceID); err != nil {
			slog.Warn("failed to reconcile domain after dev-mode change", "error", err, "device", req.DeviceID)
		}
		JSON(w, http.StatusOK, map[string]any{
			"domain": req.NewDomain,
			"status": "registered",
			"id":     domainID,
		})
		return
	}

	successURL := config.C.Server.BaseURL + "/domains?domain=success"
	cancelURL := config.C.Server.BaseURL + "/domains?domain=cancelled"

	checkoutURL, err := providers.CreateDomainCheckoutSession(r.Context(), req.DeviceID, accountID, req.NewDomain, amountCents, successURL, cancelURL)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "could not create checkout session for domain")
		return
	}

	JSON(w, http.StatusOK, map[string]any{
		"checkout_url":  checkoutURL,
		"domain":        req.NewDomain,
		"price_cents":   amountCents,
		"price_display": fmt.Sprintf("$%.2f", float64(amountCents)/100),
	})
}

// registerDomainInDB records a custom domain as active for a device/account, cancelling
// any prior active custom domain. Used only in mock purchase mode (no Stripe /
// no Cloudflare registration), so the purchase flow can be walked without a
// real registrar or payment. If deviceID is empty, the domain is owned at the
// account level and can be assigned to a device later.
func (h *PortalHandler) registerDomainInDB(deviceID, accountID, domain string, registrationCents, renewalCents int64) {
	// Cancel any existing active/grace custom domain for this device.
	if deviceID != "" {
		_, _ = h.db.Exec(
			`UPDATE custom_domains SET status = 'cancelled', auto_renew = FALSE
			 WHERE device_id = $1 AND status IN ('active','grace','payment_failed')`,
			deviceID)
	}

	domainID := security.GenerateID("dom")
	expiresAt := time.Now().AddDate(1, 0, 0)
	_, err := h.db.Exec(
		`INSERT INTO custom_domains (id, device_id, account_id, domain, registered_via, registration_cost_cents, renewal_cost_cents, auto_renew, status, expires_at)
		 VALUES ($1, $2, $3, $4, 'cloudflare', $5, $6, TRUE, 'active', $7)
		 ON CONFLICT (domain) DO UPDATE SET
		   device_id = EXCLUDED.device_id,
		   account_id = EXCLUDED.account_id,
		   status = 'active',
		   auto_renew = TRUE,
		   expires_at = EXCLUDED.expires_at`,
		domainID, deviceID, accountID, domain, int(registrationCents), int(renewalCents), expiresAt)
	if err != nil {
		slog.Error("mock domain insert failed", "error", err, "domain", domain)
	}
	// If linked to a device, apply it as serving via the single reconciler.
	if deviceID != "" {
		if err := h.domainCoord.Reconcile(deviceID); err != nil {
			slog.Warn("mock domain: reconcile failed", "error", err, "device", deviceID)
		}
	}
}

// cancelExistingDomain cancels the device's current custom domain (if any)
// by disabling CF auto-renew and setting status='cancelled'. Used during
// domain change to clean up the old domain before activating the new one.
func (h *PortalHandler) cancelExistingDomain(ctx context.Context, deviceID, apiToken, cfAccountID string) {
	var oldDomain string
	err := h.db.QueryRowContext(ctx,
		`SELECT domain FROM custom_domains WHERE device_id = $1 AND status IN ('active', 'grace')`,
		deviceID).Scan(&oldDomain)
	if err != nil || oldDomain == "" {
		return
	}
	if err := h.registrar.UpdateDomainAutoRenew(cfAccountID, apiToken, oldDomain, false); err != nil {
		slog.Warn("failed to disable auto-renew on old domain", "error", err, "domain", oldDomain)
	}
	_, _ = h.db.ExecContext(ctx,
		`UPDATE custom_domains SET status = 'cancelled', auto_renew = FALSE WHERE domain = $1`,
		oldDomain)
	slog.Info("cancelled old domain for device", "domain", oldDomain, "device", deviceID)
}

// handleDomainGraceOnDowngrade puts a device's active custom domain into grace
// status when the device is downgraded to Free. The domain keeps routing until
// expiry; CF auto-renew is disabled so the domain expires naturally. The
// scheduler revokes DNS and re-provisions the subdomain after expiry.
func (h *PortalHandler) handleDomainGraceOnDowngrade(ctx context.Context, deviceID string) {
	var domain string
	var expiresAt sql.NullTime
	err := h.db.QueryRowContext(ctx,
		`SELECT domain, expires_at FROM custom_domains WHERE device_id = $1 AND status = 'active'`,
		deviceID).Scan(&domain, &expiresAt)
	if err != nil || domain == "" {
		return // no active custom domain — nothing to grace
	}

	apiToken, cfAccountID, credErr := h.lookUpTunnelCredentialsFromContext(ctx)
	if credErr == nil {
		if err := h.registrar.UpdateDomainAutoRenew(cfAccountID, apiToken, domain, false); err != nil {
			slog.Warn("failed to disable CF auto-renew on downgrade", "error", err, "domain", domain)
		}
	}

	// Set status='grace' and record grace_until as the domain's expiry.
	if expiresAt.Valid {
		_, _ = h.db.ExecContext(ctx,
			`UPDATE custom_domains SET status = 'grace', auto_renew = FALSE, grace_until = $1 WHERE domain = $2`,
			expiresAt.Time, domain)
	} else {
		_, _ = h.db.ExecContext(ctx,
			`UPDATE custom_domains SET status = 'grace', auto_renew = FALSE WHERE domain = $1`,
			domain)
	}
	slog.Info("custom domain entered grace on downgrade", "domain", domain, "device", deviceID)
}

// reprovisionSubdomainIfNoCustomDomain re-provisions the subdomain for a device
// after a plan change, but only if the device has NO active custom domain — a
// custom domain overrides the subdomain pattern. Called on upgrade or lateral
// plan change.
func (h *PortalHandler) reprovisionSubdomainIfNoCustomDomain(ctx context.Context, deviceID string) {
	var count int
	_ = h.db.QueryRowContext(ctx,
		`SELECT 1 FROM custom_domains WHERE device_id = $1 AND status IN ('active', 'grace')`,
		deviceID).Scan(&count)
	if count > 0 {
		return // custom domain exists — skip subdomain re-provision
	}

	provSvc := services.NewProvisioningService(h.db)
	// Revoke the old subdomain credentials, then re-provision with the new plan's pattern.
	if err := provSvc.Revoke(deviceID, "domain"); err != nil {
		slog.Warn("failed to revoke subdomain on plan change", "error", err, "device", deviceID)
	}
	if _, err := provSvc.Provision(deviceID, "domain", ""); err != nil {
		slog.Warn("failed to re-provision subdomain on plan change", "error", err, "device", deviceID)
	}
}

// lookUpTunnelCredentialsFromContext is a context-friendly variant of lookUpTunnelCredentials.
func (h *PortalHandler) lookUpTunnelCredentialsFromContext(ctx context.Context) (apiToken, accountID string, err error) {
	var credentialsJSON, settingsJSON sql.NullString
	err = h.db.QueryRowContext(ctx,
		`SELECT credentials_json, settings_json FROM service_providers WHERE service = 'tunnel' AND enabled = TRUE LIMIT 1`,
	).Scan(&credentialsJSON, &settingsJSON)
	if err != nil {
		return "", "", fmt.Errorf("no tunnel provider configured")
	}
	var creds map[string]any
	json.Unmarshal([]byte(credentialsJSON.String), &creds)
	if t, ok := creds["api_token"].(string); ok {
		apiToken = t
	}
	var settings map[string]any
	json.Unmarshal([]byte(settingsJSON.String), &settings)
	if a, ok := settings["account_id"].(string); ok {
		accountID = a
	}
	return apiToken, accountID, nil
}
