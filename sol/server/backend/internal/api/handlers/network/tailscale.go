package network

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"gt.plainskill.net/LibreLoom/Sol/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/Sol/internal/auth"
	"gt.plainskill.net/LibreLoom/Sol/internal/network"
)

type TailscaleHandler struct{ service *network.TailscaleService }

func tailscaleFailure(w http.ResponseWriter, action string, err error) {
	slog.Error("Tailscale action failed", "action", action, "error", err)
	message := "Sol could not " + action + ". Try again."
	if strings.HasPrefix(err.Error(), "could not save Tailscale startup information: ") {
		JSONError(w, http.StatusBadGateway, "Sol could not save Tailscale startup information. Check Sol's storage and try again.")
		return
	}
	switch err.Error() {
	case "Sol is shutting down", "Tailscale is off. Restart Sol and try turning on private access again.", "Tailscale is starting. Try connecting again shortly", "Tailscale is starting. Try reconnecting again shortly", "Tailscale is starting. Try turning on access again shortly":
		message = strings.TrimSuffix(err.Error(), ".") + "."
	case "connect Tailscale first":
		message = "Connect Tailscale first."
	case "Tailscale is starting but not responding yet", "Sol's web listener is not ready":
		message = "Sol's remote access is starting. Wait a moment and try again."
	case "Tailscale's private listener stopped":
		message = "Sol can't offer remote access right now. Restart Sol and try again."
	}
	JSONError(w, http.StatusBadGateway, message)
}

func NewTailscaleHandler(service *network.TailscaleService) *TailscaleHandler {
	return &TailscaleHandler{service: service}
}

// Mutation revalidates an already-authenticated request after any reset finishes.
func (h *TailscaleHandler) Mutation(authService *auth.Service, next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		h.service.LockMutation()
		defer h.service.UnlockMutation()
		id, ok := middleware.GetUserID(r.Context())
		if !ok {
			JSONError(w, http.StatusUnauthorized, "Please log in again.")
			return
		}
		user, err := authService.GetUserByID(r.Context(), id)
		if err != nil || user == nil || user.Role != "admin" {
			JSONError(w, http.StatusUnauthorized, "Please log in as an Admin again.")
			return
		}
		next(w, r)
	}
}
func (h *TailscaleHandler) Status(w http.ResponseWriter, r *http.Request) {
	JSON(w, http.StatusOK, h.service.Status())
}
func (h *TailscaleHandler) Connect(w http.ResponseWriter, r *http.Request) {
	var body struct {
		ControlServer string `json:"control_server"`
	}
	if r.ContentLength != 0 && json.NewDecoder(r.Body).Decode(&body) != nil {
		JSONError(w, http.StatusBadRequest, "Sol could not read that remote access request.")
		return
	}
	st, err := h.service.ConnectWithControl(body.ControlServer)
	if err != nil {
		switch err.Error() {
		case "Headscale needs an HTTPS server address without a path":
			JSONError(w, http.StatusBadRequest, "Headscale needs an HTTPS server address without a path")
			return
		case "Sign out of Tailscale before changing the server":
			JSONError(w, http.StatusBadRequest, "Sign out of Tailscale before changing the server")
			return
		}
		tailscaleFailure(w, "connect to Tailscale", err)
		return
	}
	JSON(w, http.StatusOK, st)
}
func (h *TailscaleHandler) Reconnect(w http.ResponseWriter, r *http.Request) {
	st, err := h.service.Reconnect()
	if err != nil {
		tailscaleFailure(w, "reconnect to Tailscale", err)
		return
	}
	JSON(w, http.StatusOK, st)
}
func (h *TailscaleHandler) Serve(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Public        bool `json:"public"`
		ConfirmPublic bool `json:"confirm_public"`
	}
	if json.NewDecoder(r.Body).Decode(&body) != nil {
		JSONError(w, http.StatusBadRequest, "Sol could not read that remote access request.")
		return
	}
	if body.Public && !body.ConfirmPublic {
		JSONError(w, http.StatusBadRequest, "Confirm public access before turning it on.")
		return
	}
	st, err := h.service.Serve(body.Public)
	if err != nil {
		switch err.Error() {
		case "Public access is not available with Headscale":
			JSONError(w, http.StatusBadRequest, "Public access is not available with Headscale")
			return
		case "Sol could not turn on private access. Check your Headscale connection and HTTPS certificate settings.":
			JSONError(w, http.StatusBadRequest, "Sol could not turn on private access. Check your Headscale connection and HTTPS certificate settings.")
			return
		case "Headscale has not reported a private HTTPS address. Check its connection and certificate settings.":
			JSONError(w, http.StatusBadRequest, "Headscale has not reported a private HTTPS address. Check its connection and certificate settings.")
			return
		}
		tailscaleFailure(w, "change Tailscale access", err)
		return
	}
	JSON(w, http.StatusOK, st)
}
func (h *TailscaleHandler) StopServe(w http.ResponseWriter, r *http.Request) {
	st, err := h.service.StopServe()
	if err != nil {
		tailscaleFailure(w, "turn off Tailscale web access", err)
		return
	}
	if st.ResidualExposure {
		JSONError(w, http.StatusBadGateway, "Tailscale may still be reachable. Sol could not verify that its remote connection stopped.")
		return
	}
	JSON(w, http.StatusOK, st)
}
func (h *TailscaleHandler) Disable(w http.ResponseWriter, r *http.Request) {
	st, err := h.service.Disable()
	if err != nil {
		JSONError(w, http.StatusBadGateway, "Sol could not turn off Tailscale. Try again.")
		return
	}
	if st.ResidualExposure {
		JSONError(w, http.StatusBadGateway, "Tailscale may still be reachable. Sol could not verify that its remote connection stopped.")
		return
	}
	JSON(w, http.StatusOK, st)
}
func (h *TailscaleHandler) Forget(w http.ResponseWriter, r *http.Request) {
	st, err := h.service.Forget()
	if err != nil {
		JSONError(w, http.StatusBadGateway, "Sol could not forget this Tailscale device. Try again.")
		return
	}
	JSON(w, http.StatusOK, st)
}
