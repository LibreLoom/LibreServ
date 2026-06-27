package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database/models"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/validation"
)

// ChangePasswordRequest represents a password change request
type ChangePasswordRequest struct {
	OldPassword string `json:"old_password"`
	NewPassword string `json:"new_password"`
}

// UpdateProfileRequest represents a self-service profile update. Only fields a
// user is allowed to change for themselves are present (notably not role).
type UpdateProfileRequest struct {
	Email string `json:"email"`
}

// ChangePassword handles POST /api/v1/auth/change-password
// Updates the user's password after verifying the current password
func (h *AuthHandler) ChangePassword(w http.ResponseWriter, r *http.Request) {
	// Get user from context (set by auth middleware)
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "You must be logged in to perform this action.")
		return
	}

	user := middleware.GetUser(r.Context())
	clientIP := getClientIP(r)

	var req ChangePasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if req.OldPassword == "" || req.NewPassword == "" {
		JSONError(w, http.StatusBadRequest, "Please enter both your current password and a new password.")
		return
	}
	if err := h.authService.ValidatePassword(req.NewPassword); err != nil {
		JSONError(w, http.StatusBadRequest, "Your new password doesn't meet the requirements.")
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
			JSONError(w, http.StatusUnauthorized, "Your current password is incorrect.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "We couldn't change your password. Please try again.")
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
		JSONError(w, http.StatusUnauthorized, "You must be logged in to perform this action.")
		return
	}

	user, err := h.authService.GetUserByID(r.Context(), userID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find your account.")
		return
	}
	hasMFA, _ := h.authService.HasMFA(r.Context(), userID)
	JSON(w, http.StatusOK, meResponse{User: user.Sanitize(), MFAEnabled: hasMFA})
}

// meResponse is the /auth/me body: the sanitized user plus mfa_enabled (true
// when the user has ≥1 enabled MFA method), so the frontend can gate an
// admin-MFA blocker (admin without MFA → blocked from UI usage, not sign-in).
type meResponse struct {
	*models.User
	MFAEnabled bool `json:"mfa_enabled"`
}

// UpdateProfile handles PUT /api/v1/auth/profile
// Lets the authenticated user update their own profile (currently the email
// address). Role and username are intentionally not changeable here so a user
// cannot escalate their own privileges.
func (h *AuthHandler) UpdateProfile(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "You must be logged in to perform this action.")
		return
	}

	var req UpdateProfileRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	// Email is optional (may be cleared); validate only when provided.
	req.Email = validation.TrimAndSanitize(req.Email)
	if req.Email != "" {
		v := validation.New().ValidateEmail(req.Email)
		if v.HasErrors() {
			JSONError(w, http.StatusBadRequest, v.FirstError().Message)
			return
		}
	}

	user, err := h.authService.GetUserByID(r.Context(), userID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find your account.")
		return
	}

	if req.Email != user.Email {
		// Ensure the email isn't already used by a different account.
		if req.Email != "" {
			if existing, lookupErr := h.authService.GetUserByEmail(r.Context(), req.Email); lookupErr == nil && existing.ID != userID {
				JSONError(w, http.StatusConflict, "That email is already in use.")
				return
			}
		}
		user.Email = req.Email
		if err := h.authService.UpdateUser(r.Context(), user); err != nil {
			JSONError(w, http.StatusInternalServerError, "We couldn't update your profile. Please try again.")
			return
		}
	}

	JSON(w, http.StatusOK, user.Sanitize())
}
