package handlers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/validation"
)

const (
	accessCookieName  = "libreserv_access"
	refreshCookieName = "libreserv_refresh"
)

func isSecureRequest(r *http.Request) bool {
	if r.TLS != nil {
		return true
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
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    "",
		Path:     "/",
		Expires:  time.Unix(0, 0),
		MaxAge:   -1,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
}

// AuthHandler handles authentication-related API endpoints
type AuthHandler struct {
	authService     *auth.Service
	securityService *security.Service
}

// NewAuthHandler creates a new AuthHandler
func NewAuthHandler(authService *auth.Service, securityService *security.Service) *AuthHandler {
	return &AuthHandler{
		authService:     authService,
		securityService: securityService,
	}
}

// Login handles POST /api/v1/auth/login
// Authenticates a user and returns tokens on success
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req auth.LoginRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
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
	if err != nil {
		if err == auth.ErrInvalidCredentials {
			// Record failed login attempt
			_ = h.securityService.RecordFailedLogin(req.Username, clientIP, r.UserAgent(), "invalid credentials")
			JSONError(w, http.StatusUnauthorized, "The username or password you entered is incorrect")
			return
		}
		if strings.Contains(err.Error(), "locked") {
			// Record failed login attempt for lockout before returning error
			_ = h.securityService.RecordFailedLogin(req.Username, clientIP, r.UserAgent(), "account locked")
			JSONError(w, http.StatusTooManyRequests, "Your account is temporarily locked. Please try again later.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "failed to process login request")
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
	h.securityService.RecordEvent(r.Context(), &event)
	h.securityService.ClearFailedAttempts(clientIP, response.User.Username)

	// Set access token as HTTP-only cookie
	refreshExpiresAt, err := h.authService.TokenExpiry(response.Tokens.RefreshToken)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to set refresh token")
		return
	}
	secure := isSecureRequest(r)
	http.SetCookie(w, &http.Cookie{
		Name:     accessCookieName,
		Value:    response.Tokens.AccessToken,
		Path:     "/",
		Expires:  time.Unix(response.Tokens.ExpiresAt, 0),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    response.Tokens.RefreshToken,
		Path:     "/",
		Expires:  refreshExpiresAt,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
	JSON(w, http.StatusOK, response.User)
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
		h.securityService.RecordEvent(r.Context(), &event)
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
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.RefreshToken == "" {
		if cookie, err := r.Cookie(refreshCookieName); err == nil {
			req.RefreshToken = cookie.Value
		}
		if req.RefreshToken == "" {
			JSONError(w, http.StatusBadRequest, "refresh_token is required")
			return
		}
	}

	tokens, err := h.authService.RefreshTokensWithRotation(req.RefreshToken, "user")
	if err != nil {
		if err == auth.ErrInvalidToken || err == auth.ErrExpiredToken {
			clearAuthCookies(w, r)
			JSONError(w, http.StatusUnauthorized, "invalid or expired refresh token")
			return
		}
		if err == auth.ErrTokenRevoked {
			clearAuthCookies(w, r)
			JSONError(w, http.StatusUnauthorized, "token revoked - please log in again")
			return
		}
		JSONError(w, http.StatusInternalServerError, "failed to refresh token")
		return
	}

	refreshExpiresAt, err := h.authService.TokenExpiry(tokens.RefreshToken)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to set refresh token")
		return
	}
	secure := isSecureRequest(r)
	http.SetCookie(w, &http.Cookie{
		Name:     accessCookieName,
		Value:    tokens.AccessToken,
		Path:     "/",
		Expires:  time.Unix(tokens.ExpiresAt, 0),
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
	http.SetCookie(w, &http.Cookie{
		Name:     refreshCookieName,
		Value:    tokens.RefreshToken,
		Path:     "/",
		Expires:  refreshExpiresAt,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   secure,
	})
	JSON(w, http.StatusOK, map[string]string{"message": "refreshed"})
}
