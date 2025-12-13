package handlers

import (
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
)

// CSRFHandler issues a CSRF token for authenticated users.
type CSRFHandler struct {
	secret string
}

func NewCSRFHandler(secret string) *CSRFHandler {
	return &CSRFHandler{secret: secret}
}

func (h *CSRFHandler) GetToken(w http.ResponseWriter, r *http.Request) {
	user := middleware.GetUser(r.Context())
	if user == nil {
		JSONError(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	if h.secret == "" {
		JSONError(w, http.StatusInternalServerError, "csrf not configured")
		return
	}
	token := middleware.GenerateCSRF(h.secret, user.ID)
	JSON(w, http.StatusOK, map[string]string{
		"csrf_token": token,
	})
}
