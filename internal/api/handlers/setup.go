package handlers

import (
	"encoding/json"
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
)

// SetupHandler handles initial setup endpoints
type SetupHandler struct {
	authService *auth.Service
}

// NewSetupHandler creates a new SetupHandler
func NewSetupHandler(authService *auth.Service) *SetupHandler {
	return &SetupHandler{
		authService: authService,
	}
}

// GetStatus handles GET /api/v1/setup/status
// Returns the current setup status (whether initial setup is complete)
// This endpoint is accessible without authentication
func (h *SetupHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	status, err := h.authService.GetSetupStatus(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to check setup status")
		return
	}

	JSON(w, http.StatusOK, status)
}

// CompleteSetup handles POST /api/v1/setup/complete
// Creates the initial admin user
// This endpoint is only accessible when setup is not complete
func (h *SetupHandler) CompleteSetup(w http.ResponseWriter, r *http.Request) {
	// First check if setup is already complete
	isComplete, err := h.authService.IsSetupComplete(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "failed to check setup status")
		return
	}

	if isComplete {
		JSONError(w, http.StatusForbidden, "setup has already been completed")
		return
	}

	// Parse request
	var req auth.SetupRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate
	if req.AdminUsername == "" {
		JSONError(w, http.StatusBadRequest, "admin_username is required")
		return
	}
	if req.AdminPassword == "" {
		JSONError(w, http.StatusBadRequest, "admin_password is required")
		return
	}
	if len(req.AdminPassword) < 8 {
		JSONError(w, http.StatusBadRequest, "password must be at least 8 characters")
		return
	}

	// Complete setup
	user, err := h.authService.CompleteSetup(r.Context(), &req)
	if err != nil {
		if err == auth.ErrSetupAlreadyComplete {
			JSONError(w, http.StatusForbidden, "setup has already been completed")
			return
		}
		JSONError(w, http.StatusInternalServerError, "failed to complete setup: "+err.Error())
		return
	}

	// Generate tokens for the new admin user
	tokens, err := h.authService.Login(r.Context(), &auth.LoginRequest{
		Username: req.AdminUsername,
		Password: req.AdminPassword,
	})
	if err != nil {
		// User was created but login failed - still return success
		JSON(w, http.StatusCreated, map[string]interface{}{
			"message": "setup complete - please log in",
			"user":    user,
		})
		return
	}

	JSON(w, http.StatusCreated, map[string]interface{}{
		"message": "setup complete",
		"user":    tokens.User,
		"tokens":  tokens.Tokens,
	})
}
