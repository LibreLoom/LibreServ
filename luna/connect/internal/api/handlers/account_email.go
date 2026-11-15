package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"net/mail"
	"net/url"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

// errMailNotConfigured means this site has no email provider or API key, so a retry cannot help.
var errMailNotConfigured = errors.New("email provider not configured")

// mailNotSetUpMessage answers a send that failed because this site has no email provider.
const mailNotSetUpMessage = "Email is not set up on this Luna Connect site. Contact support."

// emailRateLimitOK enforces max 3 verification email sends per account per 60s.
// Stored in guess_attempts so blue/green instances share the budget and a
// restart does not reset it.
func emailRateLimitOK(db *database.DB, accountID string) bool {
	return allowGuess(db, "email-verify:"+accountID, 3, 60)
}

func (h AccountHandler) resendClient() *providers.ResendClient {
	if h.Resend != nil {
		return h.Resend
	}
	return providers.NewResendClient(nil)
}

// RequireVerifiedEmail blocks product routes until the account email is confirmed.
// Mount after AccountAuth; leave me / logout / resend / status / update-email outside.
func (h AccountHandler) RequireVerifiedEmail(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		acct, ok := AccountFrom(r.Context())
		if !ok {
			JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
			return
		}
		if !acct.EmailVerified {
			JSONError(w, http.StatusForbidden,
				"Verify your email address first. Open the link in the verification email, or send a new one.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// VerifyEmail confirms an account's email using a one-time token (public).
func (h AccountHandler) VerifyEmail(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Token) == "" {
		JSONError(w, http.StatusBadRequest, "Open the verification link from your email, or request a new one.")
		return
	}

	tokenHash := security.HashToken(req.Token)
	var accountID string
	err := h.DB.QueryRowContext(r.Context(),
		`SELECT account_id FROM email_verification_tokens
		 WHERE token_hash = ? AND expires_at > ?`,
		tokenHash, time.Now().Unix()).Scan(&accountID)
	if err != nil {
		JSONError(w, http.StatusBadRequest, "This verification link is invalid or has expired. Request a new one.")
		return
	}

	if _, err := h.DB.ExecContext(r.Context(),
		`UPDATE accounts SET email_verified = 1 WHERE id = ?`, accountID); err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not verify your email. Request a new link and try again.")
		return
	}
	_, _ = h.DB.ExecContext(r.Context(),
		`DELETE FROM email_verification_tokens WHERE token_hash = ?`, tokenHash)

	JSON(w, http.StatusOK, map[string]any{
		"message": "Your email is verified.",
	})
}

// ResendVerification sends a new verification email (authed, ungated).
func (h AccountHandler) ResendVerification(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Source string `json:"source"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)

	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	if acct.EmailVerified {
		// Client treats this as success-to-advance (onboarding must not dead-end).
		JSON(w, http.StatusOK, map[string]any{
			"email_verified":   true,
			"already_verified": true,
			"message":          "Your email is already verified.",
		})
		return
	}
	if !emailRateLimitOK(h.DB, acct.ID) {
		JSONError(w, http.StatusTooManyRequests, "Too many verification emails sent. Wait a minute and try again.")
		return
	}

	token, err := h.createEmailVerificationToken(r.Context(), acct.ID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not send the verification email. Try again in a few minutes.")
		return
	}
	if err := h.sendVerificationEmailSync(acct.Email, token, req.Source); err != nil {
		slog.Error("failed to send verification email", "error", err, "account", acct.ID)
		if errors.Is(err, errMailNotConfigured) {
			JSONError(w, http.StatusServiceUnavailable, mailNotSetUpMessage)
			return
		}
		JSONError(w, http.StatusInternalServerError, "Could not send the verification email. Try again in a few minutes.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{
		"message": "Verification email sent. Check your inbox and spam folder.",
	})
}

// GetVerificationStatus reports whether the signed-in account's email is verified.
func (h AccountHandler) GetVerificationStatus(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	var verified int
	err := h.DB.QueryRowContext(r.Context(),
		`SELECT email_verified FROM accounts WHERE id = ?`, acct.ID).Scan(&verified)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not load your account. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"email_verified": verified == 1})
}

// UpdateEmail changes the address on an unverified account and re-sends the link.
func (h AccountHandler) UpdateEmail(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Email  string `json:"email"`
		Source string `json:"source"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "That request was incomplete. Try again.")
		return
	}
	req.Email = strings.ToLower(strings.TrimSpace(req.Email))
	addr, err := mail.ParseAddress(req.Email)
	if err != nil || !strings.EqualFold(addr.Address, req.Email) {
		JSONError(w, http.StatusBadRequest, "Enter a valid email address.")
		return
	}

	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}

	var currentEmail string
	var verified int
	err = h.DB.QueryRowContext(r.Context(),
		`SELECT email, email_verified FROM accounts WHERE id = ?`, acct.ID).
		Scan(&currentEmail, &verified)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not load your account. Try again.")
		return
	}
	if verified == 1 {
		JSONError(w, http.StatusBadRequest, "Your email is already verified. Luna Connect cannot change a verified email.")
		return
	}
	if strings.EqualFold(currentEmail, req.Email) {
		JSONError(w, http.StatusBadRequest, "That is already the email on your account. Check your inbox and spam folder, or send the email again.")
		return
	}
	if !emailRateLimitOK(h.DB, acct.ID) {
		JSONError(w, http.StatusTooManyRequests, "Too many emails sent. Wait a minute and try again.")
		return
	}

	var otherID string
	err = h.DB.QueryRowContext(r.Context(),
		`SELECT id FROM accounts WHERE lower(email) = lower(?) AND id != ?`,
		req.Email, acct.ID).Scan(&otherID)
	if err == nil {
		JSONError(w, http.StatusConflict, "That email already has an account. Sign in with it instead.")
		return
	} else if err != sql.ErrNoRows {
		JSONError(w, http.StatusInternalServerError, "Could not update your email address. Try again.")
		return
	}

	if _, err := h.DB.ExecContext(r.Context(),
		`UPDATE accounts SET email = ? WHERE id = ?`, req.Email, acct.ID); err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not update your email address. Try again.")
		return
	}

	token, err := h.createEmailVerificationToken(r.Context(), acct.ID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not send the verification email. Try again in a few minutes.")
		return
	}
	if err := h.sendVerificationEmailSync(req.Email, token, req.Source); err != nil {
		slog.Error("failed to send verification email", "error", err, "account", acct.ID)
		if errors.Is(err, errMailNotConfigured) {
			JSONError(w, http.StatusServiceUnavailable, "Your new email is saved, but email is not set up on this Luna Connect site. Contact support.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "Your new email is saved, but the verification email did not send. Send it again in a few minutes.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{
		"message": "Verification email sent to your new address.",
		"email":   req.Email,
	})
}

func (h AccountHandler) createEmailVerificationToken(ctx context.Context, accountID string) (string, error) {
	_, _ = h.DB.ExecContext(ctx, `DELETE FROM email_verification_tokens WHERE account_id = ?`, accountID)

	token := security.RandomHex(32)
	tokenHash := security.HashToken(token)
	tokenID := security.NewID("evt")
	now := time.Now().Unix()
	_, err := h.DB.ExecContext(ctx,
		`INSERT INTO email_verification_tokens (id, account_id, token_hash, expires_at, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		tokenID, accountID, tokenHash, now+24*3600, now)
	if err != nil {
		return "", err
	}
	return token, nil
}

func (h AccountHandler) sendVerificationEmail(email, token, source string) {
	if err := h.sendVerificationEmailSync(email, token, source); err != nil {
		slog.Error("failed to send verification email", "error", err, "email", email)
	}
}

func (h AccountHandler) sendVerificationEmailSync(email, token, source string) error {
	baseURL := strings.TrimRight(strings.TrimSpace(config.C.Server.BaseURL), "/")
	if baseURL == "" {
		baseURL = "https://connect.luna.libreloom.org"
	}
	verifyURL := baseURL + "/verify-email?token=" + url.QueryEscape(token)
	if source == "onboarding" {
		verifyURL += "&from=onboarding"
	}

	htmlBody := fmt.Sprintf(`<!DOCTYPE html>
<html>
<body style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 20px;">
  <h2 style="color: #333;">Verify your email address</h2>
  <p style="color: #555; line-height: 1.6;">
    Welcome to Luna Connect. Click the button to verify your email address.
  </p>
  <p style="text-align: center; margin: 30px 0;">
    <a href="%s" style="background: #000; color: #fff; padding: 12px 32px; border-radius: 9999px; text-decoration: none; font-family: monospace;">
      Verify my email
    </a>
  </p>
  <p style="color: #888; font-size: 13px;">
    If the button does not work, copy this link into your browser:<br>
    <a href="%s" style="color: #666;">%s</a>
  </p>
  <p style="color: #888; font-size: 13px;">
    This link expires in 24 hours. If you did not make a Luna Connect account, ignore this email.
  </p>
</body>
</html>`, verifyURL, verifyURL, verifyURL)

	prov, err := providers.NewService(h.DB).FindEnabled("smtp")
	if err != nil || prov == nil {
		return fmt.Errorf("%w: no email provider configured. Add Resend in Admin → Connections", errMailNotConfigured)
	}
	apiKey := prov.Credential("api_key", "")
	if apiKey == "" {
		return fmt.Errorf("%w: resend API key not configured", errMailNotConfigured)
	}
	from := strings.TrimSpace(prov.Setting("from_email", ""))
	if from == "" {
		from = defaultVerificationFrom(baseURL)
	}
	return h.resendClient().SendEmail(apiKey, from, email, "Verify your email for Luna Connect", htmlBody, "")
}

func defaultVerificationFrom(baseURL string) string {
	host := "connect.luna.libreloom.org"
	if u, err := url.Parse(baseURL); err == nil && u.Host != "" {
		host = u.Host
	}
	return "Luna Connect <noreply@" + host + ">"
}
