package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/validation"
)

// Register handles POST /api/v1/auth/register
// Creates a new user account
func (h *AuthHandler) Register(w http.ResponseWriter, r *http.Request) {
	var req auth.RegisterRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	// Validate input
	validator := validation.New().
		ValidateUsername(req.Username).
		ValidatePassword(req.Password).
		ValidateEmail(req.Email)

	if validator.HasErrors() {
		JSONError(w, http.StatusBadRequest, validator.FirstError().Message)
		return
	}

	// Sanitize input
	req.Username = validation.TrimAndSanitize(req.Username)
	req.Email = validation.TrimAndSanitize(req.Email)

	clientIP := getClientIP(r)

	user, err := h.authService.Register(r.Context(), &req)
	if err != nil {
		if err == auth.ErrUserExists {
			JSONError(w, http.StatusConflict, "username already exists")
			return
		}
		JSONError(w, http.StatusInternalServerError, "registration failed")
		return
	}

	// Record user creation event
	event := security.Event{
		Timestamp:     time.Now(),
		EventType:     security.EventUserCreated,
		Severity:      security.SeverityInfo,
		ActorID:       user.ID,
		ActorUsername: user.Username,
		IPAddress:     clientIP,
		UserAgent:     r.UserAgent(),
		Details:       "New user account created: " + user.Username,
		Metadata: map[string]interface{}{
			"email": user.Email,
			"role":  user.Role,
		},
	}
	h.securityService.RecordEvent(r.Context(), &event)

	JSON(w, http.StatusCreated, map[string]interface{}{
		"message": "user registered successfully",
		"user":    user,
	})
}
