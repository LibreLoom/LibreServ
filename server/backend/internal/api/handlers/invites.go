package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
)

// InviteHandler handles admin-initiated account invites (POST /users/invites)
// and the public invite redemption flow (GET/POST /auth/invite/{token}[/redeem]).
// sendInvite is a func callback (not the api.EmailSender interface) to avoid an
// import cycle (api imports handlers).
type InviteHandler struct {
	authService *auth.Service
	sendInvite  func(email, token string) error // nil = SMTP not configured
}

func NewInviteHandler(authService *auth.Service, sendInvite func(email, token string) error) *InviteHandler {
	return &InviteHandler{authService: authService, sendInvite: sendInvite}
}

// SetSender wires the invite-email sender after construction (e.g. when SMTP
// settings change at runtime via Connect provisioning or Settings).
func (h *InviteHandler) SetSender(send func(email, token string) error) { h.sendInvite = send }

// CreateInvite handles POST /api/v1/users/invites (admin) {email, role}.
// Returns 201 + emails the invitee a one-time link. 400 if SMTP isn't configured.
func (h *InviteHandler) CreateInvite(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Please log in to send an invite.")
		return
	}
	if h.sendInvite == nil {
		JSONError(w, http.StatusBadRequest, "Email isn't set up on this device, so invites can't be sent. Ask your administrator to configure email first.")
		return
	}
	var req struct {
		Email string `json:"email"`
		Role  string `json:"role"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't read that request. Please try again.")
		return
	}
	req.Email = strings.TrimSpace(req.Email)
	req.Role = strings.TrimSpace(req.Role)
	if req.Email == "" || req.Role == "" {
		JSONError(w, http.StatusBadRequest, "Please provide an email address and a role (user or admin).")
		return
	}
	plaintext, inv, err := h.authService.CreateInvite(r.Context(), userID, req.Email, req.Role)
	if err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't create that invite. Please check the email and role (user or admin) and try again.")
		return
	}
	if err := h.sendInvite(inv.Email, plaintext); err != nil {
		// The invite is still valid; surface that it was created but email failed.
		JSONError(w, http.StatusInternalServerError, "We created the invite but couldn't send the email. The invite is still valid — share the link manually if needed.")
		return
	}
	JSON(w, http.StatusCreated, inv) // id, email, role, expires_at (TokenHash/InviterID are json:"-")
}

// GetInvite handles GET /api/v1/auth/invite/{token} (public).
// Returns {email, role, valid}. valid=false if expired/redeemed/unknown.
func (h *InviteHandler) GetInvite(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if token == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't find that invite.")
		return
	}
	email, role, valid, _ := h.authService.GetInvite(r.Context(), token)
	JSON(w, http.StatusOK, map[string]interface{}{"email": email, "role": role, "valid": valid})
}

// RedeemInvite handles POST /api/v1/auth/invite/{token}/redeem (public)
// {username, password}. Creates the user (inviter's role), marks the invite
// redeemed, and sets the session cookies. MFA enrollment is deferred to the
// mfa_enabled blocker (admin-without-MFA → blocked from UI, forced to enroll).
func (h *InviteHandler) RedeemInvite(w http.ResponseWriter, r *http.Request) {
	token := chi.URLParam(r, "token")
	if token == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't find that invite.")
		return
	}
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Username) == "" || req.Password == "" {
		JSONError(w, http.StatusBadRequest, "Please choose a username and set a password.")
		return
	}
	user, tokens, err := h.authService.RedeemInvite(r.Context(), token, strings.TrimSpace(req.Username), req.Password)
	if err != nil {
		switch {
		case errors.Is(err, auth.ErrInviteNotFound):
			JSONError(w, http.StatusNotFound, "That invite isn't valid. It may have expired or already been used.")
		case errors.Is(err, auth.ErrUserExists):
			JSONError(w, http.StatusConflict, "That username is already taken. Please choose another.")
		case errors.Is(err, auth.ErrEmailExists):
			JSONError(w, http.StatusConflict, "An account with that email already exists.")
		default:
			JSONError(w, http.StatusInternalServerError, "We couldn't set up your account. Please try again.")
		}
		return
	}
	if err := setSessionCookies(w, h.authService, tokens); err != nil {
		JSONError(w, http.StatusInternalServerError, "We set up your account but couldn't start your session. Try logging in.")
		return
	}
	JSON(w, http.StatusOK, user.Sanitize())
}
