package handlers

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/pagination"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database/models"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/validation"
)

// UsersHandler manages user CRUD endpoints
type UsersHandler struct {
	authService    *auth.Service
	securityEvents *security.Service
}

// NewUsersHandler creates a new UsersHandler
func NewUsersHandler(authService *auth.Service) *UsersHandler {
	return &UsersHandler{authService: authService}
}

// SetSecurityEvents sets the security event recorder (for user management notifications)
func (h *UsersHandler) SetSecurityEvents(sec *security.Service) {
	h.securityEvents = sec
}

// recordUserEvent records a user management event so notification preferences
// (notify_on_user_management) can notify admins when users are created/deleted.
func (h *UsersHandler) recordUserEvent(r *http.Request, eventType security.EventType, targetID, details string) {
	if h.securityEvents == nil {
		return
	}
	user := middleware.GetUser(r.Context())
	actorID, actorName := "", ""
	if user != nil {
		actorID, actorName = user.ID, user.Username
	}
	recordSecurityEvent(r.Context(), h.securityEvents, &security.Event{
		EventType:     eventType,
		Severity:      security.SeverityInfo,
		ActorID:       actorID,
		ActorUsername: actorName,
		IPAddress:     getClientIP(r),
		Details:       details,
		Metadata:      map[string]any{"user_id": targetID},
	})
}

// ListUsers handles GET /api/v1/users
func (h *UsersHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	// Parse pagination parameters
	params := pagination.FromRequest(r)

	users, total, err := h.authService.ListUsersPaginated(r.Context(), params.Offset, params.Limit)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load the user list. Please try again.")
		return
	}

	sanitized := make([]*models.User, len(users))
	for i, u := range users {
		sanitized[i] = u.Sanitize()
	}

	JSON(w, http.StatusOK, pagination.NewResult(sanitized, total, params))
}

// CreateUserRequest represents the payload for creating a user
type CreateUserRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Email    string `json:"email"`
	Role     string `json:"role"`
}

// CreateUser handles POST /api/v1/users
func (h *UsersHandler) CreateUser(w http.ResponseWriter, r *http.Request) {
	var req CreateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	// Validate input
	validator := validation.New().
		ValidateUsername(req.Username).
		ValidatePassword(req.Password).
		ValidateEmail(req.Email)

	if req.Role != "" {
		validator.ValidateRole(req.Role)
	}

	if validator.HasErrors() {
		JSONError(w, http.StatusBadRequest, validator.FirstError().Message)
		return
	}

	// Reject passwords that appear in known data breaches (Have I Been Pwned).
	if rejectBreachedPassword(w, req.Password) {
		return
	}

	// Sanitize input
	req.Username = validation.TrimAndSanitize(req.Username)
	req.Email = validation.TrimAndSanitize(req.Email)

	// Reuse auth service registration logic
	user, err := h.authService.Register(r.Context(), &auth.RegisterRequest{
		Username: req.Username,
		Password: req.Password,
		Email:    req.Email,
	})
	if err != nil {
		if err == auth.ErrUserExists {
			JSONError(w, http.StatusConflict, "That username is already taken. Please choose another.")
			return
		}
		if err == auth.ErrEmailExists {
			JSONError(w, http.StatusConflict, "That email address is already in use.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "We couldn't create that user. Please try again.")
		return
	}

	// Optionally set role if provided and different from default
	if req.Role != "" && req.Role != user.Role {
		user.Role = req.Role
		if err := h.authService.UpdateUser(r.Context(), user); err != nil {
			JSONError(w, http.StatusInternalServerError, "We couldn't set the user's role. Please try again.")
			return
		}
	}

	JSON(w, http.StatusCreated, map[string]interface{}{
		"user":    user.Sanitize(),
		"message": "user created",
	})

	h.recordUserEvent(r, security.EventUserCreated, user.ID,
		fmt.Sprintf("User created: %s", user.Username))
}

// GetUser handles GET /api/v1/users/{userID}
func (h *UsersHandler) GetUser(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "userID")
	if userID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which user. Please refresh and try again.")
		return
	}

	user, err := h.authService.GetUserByID(r.Context(), userID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that user. They may have been deleted.")
		return
	}
	JSON(w, http.StatusOK, user.Sanitize())
}

// UpdateUserRequest represents the payload for updating a user
type UpdateUserRequest struct {
	Email string `json:"email"`
	Role  string `json:"role"`
}

// UpdateUser handles PUT /api/v1/users/{userID}
func (h *UsersHandler) UpdateUser(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "userID")
	if userID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which user. Please refresh and try again.")
		return
	}

	var req UpdateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	// Validate input
	validator := validation.New()
	if req.Email != "" {
		validator.ValidateEmail(req.Email)
	}
	if req.Role != "" {
		validator.ValidateRole(req.Role)
	}

	if validator.HasErrors() {
		JSONError(w, http.StatusBadRequest, validator.FirstError().Message)
		return
	}

	user, err := h.authService.GetUserByID(r.Context(), userID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that user. They may have been deleted.")
		return
	}

	// An admin must not change their own role — a self-role change is a
	// privilege path that can lock them out of admin access. Email edits are fine.
	if req.Role != "" && req.Role != user.Role {
		if requesterID, ok := middleware.GetUserID(r.Context()); ok && requesterID == userID {
			JSONError(w, http.StatusForbidden, "You can't change your own role. Ask another administrator to change it for you.")
			return
		}
	}

	if req.Email != "" {
		user.Email = validation.TrimAndSanitize(req.Email)
	}
	if req.Role != "" {
		user.Role = req.Role
	}

	if err := h.authService.UpdateUser(r.Context(), user); err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't update that user. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"user":    user.Sanitize(),
		"message": "user updated",
	})
}

// DeleteUser handles DELETE /api/v1/users/{userID}
func (h *UsersHandler) DeleteUser(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "userID")
	if userID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which user. Please refresh and try again.")
		return
	}

	// An admin must not delete their own account — that ends their own
	// session and is a path to accidental lockout.
	if requesterID, ok := middleware.GetUserID(r.Context()); ok && requesterID == userID {
		JSONError(w, http.StatusForbidden, "You can't delete your own account. Ask another administrator to remove you.")
		return
	}

	if err := h.authService.DeleteUser(r.Context(), userID); err != nil {
		if err == auth.ErrUserNotFound {
			JSONError(w, http.StatusNotFound, "We couldn't find that user. They may have been deleted.")
			return
		}
		if err == auth.ErrLastAdmin {
			JSONError(w, http.StatusBadRequest, "You can't delete the last administrator account. Make another user an admin first.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "We couldn't delete that user. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"message": "user deleted",
		"user_id": userID,
	})

	h.recordUserEvent(r, security.EventUserDeleted, userID, "User deleted")
}

// SetPasswordRequest is the body for the admin set-password endpoint.
type SetPasswordRequest struct {
	NewPassword string `json:"new_password"`
}

// SetUserPassword handles PUT /api/v1/users/{userID}/password
// Lets an administrator set a user's password directly, without the old
// password. This is the admin password-management action (distinct from the
// self-service /auth/change-password flow, which verifies the old password).
func (h *UsersHandler) SetUserPassword(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "userID")
	if userID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which user. Please refresh and try again.")
		return
	}

	var req SetPasswordRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}
	if req.NewPassword == "" {
		JSONError(w, http.StatusBadRequest, "Please enter a new password.")
		return
	}
	if err := h.authService.ValidatePassword(req.NewPassword); err != nil {
		JSONError(w, http.StatusBadRequest, "That password doesn't meet the requirements. Use at least 12 characters with letters and numbers.")
		return
	}

	// Reject passwords that appear in known data breaches (Have I Been Pwned).
	if rejectBreachedPassword(w, req.NewPassword) {
		return
	}

	if err := h.authService.SetPassword(r.Context(), userID, req.NewPassword); err != nil {
		if err == auth.ErrUserNotFound {
			JSONError(w, http.StatusNotFound, "We couldn't find that user. They may have been deleted.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "We couldn't set that password. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"message": "password updated",
	})
}
