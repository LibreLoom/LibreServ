package handlers

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
)

// MFAHandler handles MFA enrollment (session-authed + CSRF) and the login-flow
// MFA endpoints (challenge / verify / recover), which are PUBLIC (auth'd only
// by the short-lived mfa_token, not a session).
type MFAHandler struct {
	authService *auth.Service
	// sendEmailOTP sends a one-time code to the user's email; nil disables email.
	sendEmailOTP func(email, code string) error
}

// NewMFAHandler creates an MFAHandler. sendEmailOTP may be nil (email methods
// then return "not configured"); wire it in main.go.
func NewMFAHandler(authService *auth.Service, sendEmailOTP func(email, code string) error) *MFAHandler {
	return &MFAHandler{authService: authService, sendEmailOTP: sendEmailOTP}
}

// SetEmailSender wires the email-OTP sender after construction.
func (h *MFAHandler) SetEmailSender(send func(email, code string) error) { h.sendEmailOTP = send }

// ----- enrollment (session-authed + CSRF) -----

// ListMethods handles GET /api/v1/auth/mfa/methods
func (h *MFAHandler) ListMethods(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Please log in to view your MFA methods.")
		return
	}
	methods, err := h.authService.ListMFAMethods(r.Context(), userID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load your MFA methods. Please try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]interface{}{"methods": methods})
}

// Availability handles GET /api/v1/auth/mfa/availability
// Reports which enrollment methods the server can actually service right now,
// so the UI can hide unavailable options instead of letting the user pick one
// and fail partway through. Each flag:
//
//	totp         — the at-rest TOTP encryption key is configured
//	email        — an email-OTP sender is wired AND the caller has an email
//	               address on their account (codes are delivered to it)
//	passkey / security_key — a WebAuthn verifier is wired
//
// Authenticated (session-authed); same group as the other enrollment reads.
func (h *MFAHandler) Availability(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Please log in to view available sign-in methods.")
		return
	}
	hasEmail := false
	if u, err := h.authService.GetUserByID(r.Context(), userID); err == nil {
		hasEmail = strings.TrimSpace(u.Email) != ""
	}
	JSON(w, http.StatusOK, map[string]interface{}{
		"totp":         h.authService.MFATOTPEncryptionKeySet(),
		"email":        h.sendEmailOTP != nil && hasEmail,
		"passkey":      h.authService.WebAuthnAvailable(),
		"security_key": h.authService.WebAuthnAvailable(),
	})
}

// SetupTOTP handles POST /api/v1/auth/mfa/totp/setup {label?}
// Returns {secret, otpauth_uri, qr_image} (qr_image is a base64 PNG data URI).
func (h *MFAHandler) SetupTOTP(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Please log in to set up an authenticator app.")
		return
	}
	user := middleware.GetUser(r.Context())
	var req struct {
		Label string `json:"label"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if h.authService.MFATOTPEncryptionKeySet() == false {
		JSONError(w, http.StatusServiceUnavailable, "An authenticator app can't be set up right now. Ask your administrator to configure MFA.")
		return
	}
	secret, otpauthURI, qr, err := h.authService.SetupTOTP(r.Context(), userID, user.Username, req.Label)
	if err != nil {
		slog.Warn("SetupTOTP failed", "user_id", userID, "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't set up your authenticator app. Please try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]interface{}{
		"secret":      secret,
		"otpauth_uri": otpauthURI,
		"qr_image":    qr,
	})
}

// VerifyTOTP handles POST /api/v1/auth/mfa/totp/verify {code}
func (h *MFAHandler) VerifyTOTP(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Please log in to finish setup.")
		return
	}
	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Code) == "" {
		JSONError(w, http.StatusBadRequest, "Please enter the 6-digit code from your app.")
		return
	}
	if err := h.authService.VerifyTOTP(r.Context(), userID, strings.TrimSpace(req.Code)); err != nil {
		JSONError(w, http.StatusBadRequest, "That code didn't work. Make sure your device's time is correct and try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]string{"message": "Authenticator app added."})
}

// SetupEmail handles POST /api/v1/auth/mfa/email/setup {label?}
func (h *MFAHandler) SetupEmail(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Please log in to set up email sign-in codes.")
		return
	}
	if h.sendEmailOTP == nil {
		JSONError(w, http.StatusServiceUnavailable, "Email sign-in codes aren't configured on this device.")
		return
	}
	var req struct {
		Label string `json:"label"`
	}
	_ = json.NewDecoder(r.Body).Decode(&req)
	if _, err := h.authService.SetupEmail(r.Context(), userID, req.Label, h.sendEmailOTP); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't send a code to your email. Check that your account has an email address and try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]string{"message": "We sent a code to your email."})
}

// VerifyEmail handles POST /api/v1/auth/mfa/email/verify {code}
func (h *MFAHandler) VerifyEmail(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Please log in to finish setup.")
		return
	}
	var req struct {
		Code string `json:"code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Code) == "" {
		JSONError(w, http.StatusBadRequest, "Please enter the 6-digit code from your email.")
		return
	}
	if err := h.authService.VerifyEmailSetup(r.Context(), userID, strings.TrimSpace(req.Code)); err != nil {
		JSONError(w, http.StatusBadRequest, "That code didn't work, or it may have expired. Try sending a new one.")
		return
	}
	JSON(w, http.StatusOK, map[string]string{"message": "Email sign-in code added."})
}

// GenerateRecoveryCodes handles POST /api/v1/auth/mfa/recovery-codes
// Returns the plaintext codes exactly once.
func (h *MFAHandler) GenerateRecoveryCodes(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Please log in to generate recovery codes.")
		return
	}
	codes, err := h.authService.GenerateRecoveryCodes(r.Context(), userID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't generate recovery codes. Please try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]interface{}{
		"codes":   codes,
		"message": "Copy these codes now — you won't be able to see them again.",
	})
}

// RecoveryCodesRemaining handles GET /api/v1/auth/mfa/recovery-codes
func (h *MFAHandler) RecoveryCodesRemaining(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Please log in to view recovery codes.")
		return
	}
	n, err := h.authService.RecoveryCodesRemaining(r.Context(), userID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't check your recovery codes. Please try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]interface{}{"remaining": n})
}

// DeleteMethod handles DELETE /api/v1/auth/mfa/methods/{id}
func (h *MFAHandler) DeleteMethod(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Please log in to remove an MFA method.")
		return
	}
	methodID := chi.URLParam(r, "id")
	if methodID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which method to remove.")
		return
	}
	if err := h.authService.DeleteMFAMethod(r.Context(), userID, methodID); err != nil {
		switch {
		case errors.Is(err, auth.ErrMFALastMethod):
			JSONError(w, http.StatusConflict, "You can't remove your only MFA method. You need at least one enabled to stay logged in safely.")
		case errors.Is(err, auth.ErrMFANotFound):
			JSONError(w, http.StatusNotFound, "We couldn't find that MFA method.")
		default:
			JSONError(w, http.StatusInternalServerError, "We couldn't remove that MFA method. Please try again.")
		}
		return
	}
	JSON(w, http.StatusOK, map[string]string{"message": "MFA method removed."})
}

// ----- login-flow (PUBLIC — authed by mfa_token, not a session) -----

// Challenge handles POST /api/v1/auth/mfa/challenge {mfa_token, type}
func (h *MFAHandler) Challenge(w http.ResponseWriter, r *http.Request) {
	var req struct {
		MFAToken string `json:"mfa_token"`
		Type     string `json:"type"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.MFAToken == "" || req.Type == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a sign-in method to continue.")
		return
	}
	user, err := h.authService.ValidateMFAToken(r.Context(), req.MFAToken)
	if err != nil {
		JSONError(w, http.StatusUnauthorized, "Your sign-in session expired. Please log in again.")
		return
	}
	options, err := h.authService.BeginMFAChallenge(r.Context(), user.ID, req.Type, h.sendEmailOTP)
	if err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't start that sign-in method. Please try another.")
		return
	}
	// For webauthn types, options is the PublicKeyCredentialRequestOptions
	// (base64url buffer fields, verbatim from the verifier). For email/totp it's
	// a small status object. Always return under "options" so the frontend's
	// webauthn path can read it uniformly.
	JSON(w, http.StatusOK, map[string]interface{}{"options": json.RawMessage(options)})
}

// Verify handles POST /api/v1/auth/mfa/verify {mfa_token, type, payload}
// On success, sets the session cookies (login completes).
func (h *MFAHandler) Verify(w http.ResponseWriter, r *http.Request) {
	var req struct {
		MFAToken string          `json:"mfa_token"`
		Type     string          `json:"type"`
		Payload  json.RawMessage `json:"payload"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.MFAToken == "" || req.Type == "" {
		JSONError(w, http.StatusBadRequest, "Please complete the sign-in step to continue.")
		return
	}
	user, err := h.authService.ValidateMFAToken(r.Context(), req.MFAToken)
	if err != nil {
		JSONError(w, http.StatusUnauthorized, "Your sign-in session expired. Please log in again.")
		return
	}
	tokens, err := h.authService.VerifyMFA(r.Context(), user.ID, user.Username, user.Role, req.Type, req.Payload, h.sendEmailOTP)
	if err != nil {
		JSONError(w, http.StatusUnauthorized, "That didn't work. Double-check the code and try again.")
		return
	}
	if err := setSessionCookies(w, h.authService, tokens); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't set up your session. Please try again.")
		return
	}
	JSON(w, http.StatusOK, user.Sanitize())
}

// Recover handles POST /api/v1/auth/mfa/recover {mfa_token, recovery_code}
// On success, sets the session cookies (login completes).
func (h *MFAHandler) Recover(w http.ResponseWriter, r *http.Request) {
	var req struct {
		MFAToken     string `json:"mfa_token"`
		RecoveryCode string `json:"recovery_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.MFAToken == "" || req.RecoveryCode == "" {
		JSONError(w, http.StatusBadRequest, "Please enter a recovery code to continue.")
		return
	}
	user, err := h.authService.ValidateMFAToken(r.Context(), req.MFAToken)
	if err != nil {
		JSONError(w, http.StatusUnauthorized, "Your sign-in session expired. Please log in again.")
		return
	}
	if err := h.authService.VerifyRecoveryCode(r.Context(), user.ID, strings.TrimSpace(req.RecoveryCode)); err != nil {
		JSONError(w, http.StatusUnauthorized, "That recovery code didn't work. It may be wrong or already used.")
		return
	}
	tokens, err := h.authService.GenerateTokenPairForUser(r.Context(), user.ID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't sign you in. Please try again.")
		return
	}
	if err := setSessionCookies(w, h.authService, tokens); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't set up your session. Please try again.")
		return
	}
	JSON(w, http.StatusOK, user.Sanitize())
}
