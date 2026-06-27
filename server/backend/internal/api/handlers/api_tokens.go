package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
)

// APITokensHandler manages a user's long-lived API tokens (programmatic access).
type APITokensHandler struct {
	authService *auth.Service
}

func NewAPITokensHandler(authService *auth.Service) *APITokensHandler {
	return &APITokensHandler{authService: authService}
}

type createAPITokenRequest struct {
	Name string `json:"name"`
}

// List handles GET /api/v1/api-tokens — a user's tokens (hashes never included).
func (h *APITokensHandler) List(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Please log in to view your API tokens.")
		return
	}
	tokens, err := h.authService.ListAPITokens(r.Context(), userID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't load your API tokens. Please try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]interface{}{"tokens": tokens})
}

// Create handles POST /api/v1/api-tokens. The plaintext token is returned
// exactly once — the user must copy it now; it cannot be retrieved later.
func (h *APITokensHandler) Create(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Please log in to create an API token.")
		return
	}
	var req createAPITokenRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Name) == "" {
		JSONError(w, http.StatusBadRequest, "Please give the token a name so you can recognize it later.")
		return
	}
	plaintext, rec, err := h.authService.CreateAPIToken(r.Context(), userID, strings.TrimSpace(req.Name))
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't create that API token. Please try again.")
		return
	}
	JSON(w, http.StatusCreated, map[string]interface{}{
		"token":     plaintext,
		"api_token": rec,
		"message":   "Copy this token now — you won't be able to see it again.",
	})
}

// Revoke handles DELETE /api/v1/api-tokens/{id}.
func (h *APITokensHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Please log in to revoke an API token.")
		return
	}
	tokenID := chi.URLParam(r, "id")
	if tokenID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which token to revoke.")
		return
	}
	if err := h.authService.RevokeAPIToken(r.Context(), userID, tokenID); err != nil {
		if err == auth.ErrAPITokenNotFound {
			JSONError(w, http.StatusNotFound, "We couldn't find that API token. It may have already been revoked.")
			return
		}
		JSONError(w, http.StatusInternalServerError, "We couldn't revoke that API token. Please try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]string{"message": "API token revoked"})
}
