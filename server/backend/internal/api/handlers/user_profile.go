package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
)

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

	user := middleware.GetUser(r.Context())
	clientIP := getClientIP(r)

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
		JSONError(w, http.StatusBadRequest, "password does not meet requirements")
		return
	}

	err := h.authService.ChangePassword(r.Context(), userID, req.OldPassword, req.NewPassword)
	if err != nil {
		if err == auth.ErrInvalidCredentials {
			// Record failed password change attempt
			if user != nil {
				event := security.Event{
					Timestamp:     time.Now(),
					EventType:     security.EventSuspiciousActivity,
					Severity:      security.SeverityWarning,
					ActorID:       userID,
					ActorUsername: user.Username,
					IPAddress:     clientIP,
					UserAgent:     r.UserAgent(),
					Details:       "Failed password change attempt - incorrect current password",
				}
				h.securityService.RecordEvent(r.Context(), &event)
			}
			JSONError(w, http.StatusUnauthorized, "current password is incorrect")
			return
		}
		JSONError(w, http.StatusInternalServerError, "failed to change password")
		return
	}

	// Record password change event
	if user != nil {
		event := security.Event{
			Timestamp:     time.Now(),
			EventType:     security.EventPasswordChanged,
			Severity:      security.SeverityWarning,
			ActorID:       userID,
			ActorUsername: user.Username,
			IPAddress:     clientIP,
			UserAgent:     r.UserAgent(),
			Details:       fmt.Sprintf("Password changed for user %s", user.Username),
		}
		h.securityService.RecordEvent(r.Context(), &event)
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
