package network

import (
	"encoding/json"
	"log/slog"
	"net/http"

	"gt.plainskill.net/LibreLoom/Sol/internal/network"
)

type TailscaleHandler struct{ service *network.TailscaleService }

func tailscaleFailure(w http.ResponseWriter, action string, err error) {
	slog.Error("Tailscale action failed", "action", action, "error", err)
	JSONError(w, http.StatusBadGateway, "Sol could not "+action+". Check the internet connection and try again, or turn off Tailscale.")
}

func NewTailscaleHandler(service *network.TailscaleService) *TailscaleHandler {
	return &TailscaleHandler{service: service}
}
func (h *TailscaleHandler) Status(w http.ResponseWriter, r *http.Request) {
	JSON(w, http.StatusOK, h.service.Status())
}
func (h *TailscaleHandler) Connect(w http.ResponseWriter, r *http.Request) {
	st, err := h.service.Connect()
	if err != nil {
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
	JSON(w, http.StatusOK, st)
}
func (h *TailscaleHandler) Disable(w http.ResponseWriter, r *http.Request) {
	st, err := h.service.Disable()
	if err != nil {
		JSONError(w, http.StatusBadGateway, "Sol could not turn off Tailscale. Try again.")
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
