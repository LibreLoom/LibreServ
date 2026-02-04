package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/pagination"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/validation"
)

// UsersHandler manages user CRUD endpoints
type UsersHandler struct {
	authService *auth.Service
}

// NewUsersHandler creates a new UsersHandler
func NewUsersHandler(authService *auth.Service) *UsersHandler {
	return &UsersHandler{authService: authService}
}

// ListUsers handles GET /api/v1/users
func (h *UsersHandler) ListUsers(w http.ResponseWriter, r *http.Request) {
	// Parse pagination parameters
	params := pagination.FromRequest(r)

	users, total, err := h.authService.ListUsersPaginated(r.Context(), params.Offset, params.Limit)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to list users: "+err.Error())
		return
	}

	// scrub password hashes
	for _, u := range users {
		u.PasswordHash = ""
	}

	JSON(w, http.StatusOK, pagination.NewResult(users, total, params))
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
		JSONError(w, http.StatusBadRequest, "invalid request body")
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
			JSONError(w, http.StatusConflict, "username already exists")
			return
		}
		JSONError(w, http.StatusInternalServerError, "failed to create user: "+err.Error())
		return
	}

	// Optionally set role if provided and different from default
	if req.Role != "" && req.Role != user.Role {
		user.Role = req.Role
		if err := h.authService.UpdateUser(r.Context(), user); err != nil {
			JSONError(w, http.StatusInternalServerError, "failed to set role: "+err.Error())
			return
		}
	}
	user.PasswordHash = ""

	JSON(w, http.StatusCreated, map[string]interface{}{
		"user":    user,
		"message": "user created",
	})
}

// GetUser handles GET /api/v1/users/{userID}
func (h *UsersHandler) GetUser(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "userID")
	if userID == "" {
		JSONError(w, http.StatusBadRequest, "user ID required")
		return
	}

	user, err := h.authService.GetUserByID(r.Context(), userID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "user not found")
		return
	}
	user.PasswordHash = ""
	JSON(w, http.StatusOK, user)
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
		JSONError(w, http.StatusBadRequest, "user ID required")
		return
	}

	var req UpdateUserRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
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
		JSONError(w, http.StatusNotFound, "user not found")
		return
	}

	if req.Email != "" {
		user.Email = validation.TrimAndSanitize(req.Email)
	}
	if req.Role != "" {
		user.Role = req.Role
	}

	if err := h.authService.UpdateUser(r.Context(), user); err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to update user: "+err.Error())
		return
	}

	user.PasswordHash = ""
	JSON(w, http.StatusOK, map[string]interface{}{
		"user":    user,
		"message": "user updated",
	})
}

// DeleteUser handles DELETE /api/v1/users/{userID}
func (h *UsersHandler) DeleteUser(w http.ResponseWriter, r *http.Request) {
	userID := chi.URLParam(r, "userID")
	if userID == "" {
		JSONError(w, http.StatusBadRequest, "user ID required")
		return
	}

	if err := h.authService.DeleteUser(r.Context(), userID); err != nil {
		if err == auth.ErrUserNotFound {
			JSONError(w, http.StatusNotFound, "user not found")
			return
		}
		JSONError(w, http.StatusInternalServerError, "failed to delete user: "+err.Error())
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"message": "user deleted",
		"user_id": userID,
	})
}

// InviteUser is a placeholder for future invites
func (h *UsersHandler) InviteUser(w http.ResponseWriter, r *http.Request) {
	JSONError(w, http.StatusNotImplemented, "invites not implemented")
}
