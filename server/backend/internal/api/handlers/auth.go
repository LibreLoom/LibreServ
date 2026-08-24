package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/validation"
)

const (
	accessCookieName  = "libreserv_access"
	refreshCookieName = "libreserv_refresh"
)

// isSecureRequest reports whether the client is on a confidential transport:
// a direct TLS connection, or an https:// request forwarded by a trusted proxy
// (Caddy). The auth/setup cookies are marked Secure only when the request is
// HTTPS end-to-end; browsers refuse to store Secure cookies on plain http:// so
// hard-coding Secure:true would lock users out whenever they reach the device
// over plain HTTP — which is exactly how the whole setup wizard runs before
// Caddy/proxy/domain configuration exists (e.g. http://192.168.x.x:8080).
// Trusted-proxy detection mirrors getClientIP, and the 127.0.0.1/8 etc.
// fallbacks are on the same trustedProxyNets list (rate_limit.go), so a
// spoofed X-Forwarded-Proto from an untrusted client is ignored here.
func isSecureRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	remote := r.RemoteAddr
	if h, _, err := net.SplitHostPort(remote); err == nil {
		remote = h
	}
	ip := net.ParseIP(remote)
	if ip == nil || !middleware.IsTrustedProxyIP(ip) {
		return false
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

func clearAuthCookies(w http.ResponseWriter, r *http.Request) {
	secure := isSecureRequest(r)
	http.SetCookie(w, &http.Cookie{
		Name:     accessCookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   secure,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   true,
	})
}

// AuthHandler handles authentication-related API endpoints
type AuthHandler struct {
	authService          *auth.Service
	securityService      *security.Service
	passwordResetService *auth.PasswordResetService
}

// NewAuthHandler creates a new AuthHandler
func NewAuthHandler(authService *auth.Service, securityService *security.Service, db auth.DatabaseInterface) *AuthHandler {
	h := &AuthHandler{
		authService:     authService,
		securityService: securityService,
	}
	h.passwordResetService = auth.NewPasswordResetService(authService, email.NewSender, db)
	return h
}

// Login handles POST /api/v1/auth/login
// Authenticates a user and returns tokens on success
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req auth.LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	// Validate input
	validator := validation.New().
		ValidateUsername(req.Username).
		ValidateNotEmpty("password", req.Password, "Password")

	if validator.HasErrors() {
		JSONError(w, http.StatusBadRequest, validator.FirstError().Message)
		return
	}

	// Sanitize input
	req.Username = validation.TrimAndSanitize(req.Username)

	clientIP := getClientIP(r)

	response, err := h.authService.Login(r.Context(), &req)
	var mfaReq *auth.MFARequiredError
	if errors.As(err, &mfaReq) {
		// Password was valid but the user has MFA — do NOT set a session.
		// Return the short-lived mfa_token + the enabled-method picker list.
		JSON(w, http.StatusOK, map[string]interface{}{
			"status":    "mfa_required",
			"mfa_token": mfaReq.MFAToken,
			"methods":   mfaReq.Methods,
			"email":     mfaReq.Email,
		})
		return
	}
	if err != nil {
		if err == auth.ErrInvalidCredentials {
			// Record failed login attempt
			if err := h.securityService.RecordFailedLogin(req.Username, clientIP, r.UserAgent(), "invalid credentials"); err != nil {
				slog.Error("Failed to record failed login attempt", "username", req.Username, "ip", clientIP, "error", err)
			}
			JSONError(w, http.StatusUnauthorized, "The username or password you entered is incorrect")
			return
		}
		if strings.Contains(err.Error(), "locked") {
			// Record failed login attempt for lockout before returning error
			if err := h.securityService.RecordFailedLogin(req.Username, clientIP, r.UserAgent(), "account locked"); err != nil {
				slog.Error("Failed to record locked-account login attempt", "username", req.Username, "ip", clientIP, "error", err)
			}
			JSONError(w, http.StatusTooManyRequests, "Your account is temporarily locked. Please try again later.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "We couldn't sign you in. Please try again.")
		return
	}

	// Record successful login
	event := security.Event{
		Timestamp:     time.Now(),
		EventType:     security.EventLoginSuccess,
		Severity:      security.SeverityInfo,
		ActorID:       response.User.ID,
		ActorUsername: response.User.Username,
		IPAddress:     clientIP,
		UserAgent:     r.UserAgent(),
		Details:       fmt.Sprintf("Successful login for user %s", response.User.Username),
	}
	recordSecurityEvent(r.Context(), h.securityService, &event)
	h.securityService.ClearFailedAttempts(clientIP, response.User.Username)

	// Set access + refresh tokens as HTTP-only cookies.
	if err := setSessionCookies(w, h.authService, response.Tokens, isSecureRequest(r)); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't set up your session. Please try again.")
		return
	}
	JSON(w, http.StatusOK, response.User.Sanitize())
}

// setSessionCookies sets the access + refresh HTTP-only cookies for a token
// pair. Shared by Login and the MFA verify/recover flows (which also complete a
// session after a valid MFA challenge). The Secure flag follows the request
// transport (isSecureRequest) so sessions work over plain http:// (setup,
// LAN access) while staying Secure behind TLS.
func setSessionCookies(w http.ResponseWriter, authService *auth.Service, tokens *auth.TokenPair, secure bool) error {
	refreshExpiresAt, err := authService.TokenExpiry(tokens.RefreshToken)
	if err != nil {
		return err
	}
	http.SetCookie(w, &http.Cookie{
		Name: accessCookieName, Value: tokens.AccessToken, Path: "/",
		Expires:  time.Unix(tokens.ExpiresAt, 0),
		HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: secure,
	})
	http.SetCookie(w, &http.Cookie{
		Name: refreshCookieName, Value: tokens.RefreshToken, Path: "/",
		Expires:  refreshExpiresAt,
		HttpOnly: true, SameSite: http.SameSiteStrictMode, Secure: secure,
	})
	return nil
}

// Logout handles POST /api/v1/auth/logout
// Clears the access token cookie and revokes all tokens for the user (#18)
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	userID, _ := middleware.GetUserID(r.Context())
	user := middleware.GetUser(r.Context())
	clientIP := getClientIP(r)

	if userID != "" {
		_ = h.authService.RevokeAllTokens(userID, userID, "User logout")
	}

	// Record logout event
	if user != nil {
		event := security.Event{
			Timestamp:     time.Now(),
			EventType:     security.EventLogout,
			Severity:      security.SeverityInfo,
			ActorID:       userID,
			ActorUsername: user.Username,
			IPAddress:     clientIP,
			UserAgent:     r.UserAgent(),
			Details:       fmt.Sprintf("User %s logged out", user.Username),
		}
		recordSecurityEvent(r.Context(), h.securityService, &event)
	}

	clearAuthCookies(w, r)
	JSON(w, http.StatusOK, map[string]string{"message": "logged out"})
}

// RefreshToken handles POST /api/v1/auth/refresh
// Exchanges a refresh token for a new access token with proper rotation (#19)
func (h *AuthHandler) RefreshToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		RefreshToken string `json:"refresh_token"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil && !errors.Is(err, io.EOF) {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if req.RefreshToken == "" {
		if cookie, err := r.Cookie(refreshCookieName); err == nil {
			req.RefreshToken = cookie.Value
		}
		if req.RefreshToken == "" {
			JSONError(w, http.StatusBadRequest, "Your session needs to be refreshed. Please log in again.")
			return
		}
	}

	tokens, err := h.authService.RefreshTokensWithRotation(req.RefreshToken, "user")
	if err != nil {
		if err == auth.ErrInvalidToken || err == auth.ErrExpiredToken {
			clearAuthCookies(w, r)
			JSONError(w, http.StatusUnauthorized, "Your session has expired. Please log in again.")
			return
		}
		if err == auth.ErrTokenRevoked {
			clearAuthCookies(w, r)
			JSONError(w, http.StatusUnauthorized, "Your session was ended. Please log in again.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "We couldn't refresh your session. Please try again.")
		return
	}

	refreshExpiresAt, err := h.authService.TokenExpiry(tokens.RefreshToken)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't set up your session. Please try again.")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     accessCookieName,
		Value:    tokens.AccessToken,
		Path:     "/",
		Expires:  time.Unix(tokens.ExpiresAt, 0),
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   isSecureRequest(r),
	})
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    tokens.RefreshToken,
		Path:     "/",
		Expires:  refreshExpiresAt,
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		Secure:   isSecureRequest(r),
	})
	JSON(w, http.StatusOK, map[string]string{"message": "refreshed"})
}

// RequestPasswordReset handles POST /api/v1/auth/password-reset/request
func (h *AuthHandler) RequestPasswordReset(w http.ResponseWriter, r *http.Request) {
	var req auth.ResetRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if req.Email == "" {
		JSONError(w, http.StatusBadRequest, "Please enter your email address.")
		return
	}

	if err := h.passwordResetService.RequestReset(r.Context(), req.Email); err != nil {
		slog.Error("Password reset request failed", "email", req.Email, "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't send the password reset request. Please try again later.")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message": "If an account exists with that email, a password reset link has been sent",
	})
}

// ConfirmPasswordReset handles POST /api/v1/auth/password-reset/confirm
func (h *AuthHandler) ConfirmPasswordReset(w http.ResponseWriter, r *http.Request) {
	var req auth.ResetConfirm
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if req.Token == "" || req.NewPassword == "" {
		JSONError(w, http.StatusBadRequest, "Please provide the reset link and a new password.")
		return
	}

	user, err := h.passwordResetService.ValidateToken(r.Context(), req.Token)
	if err != nil {
		slog.Warn("Password reset token validation failed", "error", err)
		JSONError(w, http.StatusBadRequest, "That reset link is invalid or has expired. Please request a new one.")
		return
	}

	// Reject passwords that appear in known data breaches (Have I Been Pwned).
	// Checked before the token is consumed so the user can pick another
	// password and reuse the same reset link.
	if rejectBreachedPassword(w, req.NewPassword) {
		return
	}

	if err := h.passwordResetService.ResetPassword(r.Context(), req.Token, req.NewPassword); err != nil {
		slog.Error("Password reset failed", "error", err)
		JSONError(w, http.StatusBadRequest, "We couldn't reset that password. Check that the link is correct and hasn't expired.")
		return
	}

	// Record security event
	event := security.Event{
		Timestamp:     time.Now(),
		EventType:     security.EventPasswordReset,
		Severity:      security.SeverityWarning,
		ActorID:       user.ID,
		ActorUsername: user.Username,
		IPAddress:     getClientIP(r),
		UserAgent:     r.UserAgent(),
		Details:       fmt.Sprintf("Password reset completed for user %s", user.Username),
	}
	recordSecurityEvent(r.Context(), h.securityService, &event)

	JSON(w, http.StatusOK, map[string]string{
		"message": "Password reset successfully",
	})
}

// ValidateResetToken handles POST /api/v1/auth/password-reset/validate
func (h *AuthHandler) ValidateResetToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token string `json:"token"`
	}
	if r.Method == http.MethodPost {
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.Token == "" {
			JSONError(w, http.StatusBadRequest, "Please provide the reset token from your email link.")
			return
		}
	} else {
		req.Token = r.URL.Query().Get("token")
		if req.Token == "" {
			JSONError(w, http.StatusBadRequest, "Please provide the reset token from your email link.")
			return
		}
	}

	_, err := h.passwordResetService.ValidateToken(r.Context(), req.Token)
	if err != nil {
		JSON(w, http.StatusOK, map[string]interface{}{
			"valid": false,
		})
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"valid": true,
	})
}
