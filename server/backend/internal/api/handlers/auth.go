package handlers

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
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
	authService *auth.Service
}

// NewAuthHandler creates a new AuthHandler
func NewAuthHandler(authService *auth.Service) *AuthHandler {
	return &AuthHandler{
		authService: authService,
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

	if req.Username == "" || req.Password == "" {
		JSONError(w, http.StatusBadRequest, "username and password are required")
		return
	}

	response, err := h.authService.Login(r.Context(), &req)
	if err != nil {
		if err == auth.ErrInvalidCredentials {
			JSONError(w, http.StatusUnauthorized, "invalid username or password")
			return
		}
		if strings.Contains(err.Error(), "locked") {
			JSONError(w, http.StatusTooManyRequests, "account temporarily locked")
			return
		}
		JSONError(w, http.StatusInternalServerError, "login failed")
		return
	}
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
// Clears the access token cookie and logs the user out
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	clearAuthCookies(w, r)
	JSON(w, http.StatusOK, map[string]string{"message": "logged out"})
}

// Register handles POST /api/v1/auth/register
// Creates a new user account
func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req auth.RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Username == "" || req.Password == "" {
		JSONError(w, http.StatusBadRequest, "username and password are required")
		return
	}
	if err := h.authService.ValidatePassword(req.Password); err != nil {
		JSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	user, err := h.authService.Register(r.Context(), &req)
	if err != nil {
		if err == auth.ErrUserExists {
			JSONError(w, http.StatusConflict, "username already exists")
			return
		}
		if err == auth.ErrPasswordTooShort {
			JSONError(w, http.StatusBadRequest, "password must be at least 8 characters")
			return
		}
		JSONError(w, http.StatusInternalServerError, "registration failed")
		return
	}

	JSON(w, http.StatusCreated, map[string]interface{}{
		"message": "user registered successfully",
		"user":    user,
	})
}

// RefreshToken handles POST /api/v1/auth/refresh
// Exchanges a refresh token for a new access token
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

	tokens, err := h.authService.RefreshTokens(req.RefreshToken)
	if err != nil {
		if err == auth.ErrInvalidToken || err == auth.ErrExpiredToken {
			clearAuthCookies(w, r)
			JSONError(w, http.StatusUnauthorized, "invalid or expired refresh token")
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

// ChangePasswordRequest represents a password change request
type ChangePasswordRequest struct {
	OldPassword string `json:"old_password"`
	NewPassword string `json:"new_password"`
}

// ChangePassword handles POST /api/v1/auth/change-password
// Updates the user's password after verifying the current password
func (h *AuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	// Get user from context (set by auth middleware)
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	var req ChangePasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.OldPassword == "" || req.NewPassword == "" {
		JSONError(w, http.StatusBadRequest, "old_password and new_password are required")
		return
	}
	if err := h.authService.ValidatePassword(req.NewPassword); err != nil {
		JSONError(w, http.StatusBadRequest, err.Error())
		return
	}

	err := h.authService.ChangePassword(r.Context(), userID, req.OldPassword, req.NewPassword)
	if err != nil {
		if err == auth.ErrInvalidCredentials {
			JSONError(w, http.StatusUnauthorized, "current password is incorrect")
			return
		}
		if err == auth.ErrPasswordTooShort {
			JSONError(w, http.StatusBadRequest, "new password must be at least 8 characters")
			return
		}
		JSONError(w, http.StatusInternalServerError, "failed to change password")
		return
	}

	JSON(w, http.StatusOK, map[string]string{
		"message": "password changed successfully",
	})
}

// Me handles GET /api/v1/auth/me
// Returns the current authenticated user's information
func (h *AuthHandler) Me(w http.ResponseWriter, r *http.Request) {
	// Get user ID from context (set by auth middleware)
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "authentication required")
		return
	}

	user, err := h.authService.GetUserByID(r.Context(), userID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "user not found")
		return
	}

	JSON(w, http.StatusOK, user)
}
