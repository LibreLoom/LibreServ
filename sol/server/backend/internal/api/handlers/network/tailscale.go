package network

import (
	"encoding/json"
	"net/http"

	"gt.plainskill.net/LibreLoom/Sol/internal/network"
)

type TailscaleHandler struct{ service *network.TailscaleService }

func NewTailscaleHandler(service *network.TailscaleService) *TailscaleHandler {
	return &TailscaleHandler{service: service}
}
func (h *TailscaleHandler) Status(w http.ResponseWriter, r *http.Request) {
	JSON(w, http.StatusOK, h.service.Status())
}
func (h *TailscaleHandler) Connect(w http.ResponseWriter, r *http.Request) {
	st, err := h.service.Connect()
	if err != nil {
		JSONError(w, http.StatusBadGateway, "Sol could not connect to Tailscale. Check the connection and try again.")
		return
	}
	JSON(w, http.StatusOK, st)
}
func (h *TailscaleHandler) Reconnect(w http.ResponseWriter, r *http.Request) {
	st, err := h.service.Reconnect()
	if err != nil {
		JSONError(w, http.StatusBadGateway, "Sol could not reconnect to Tailscale. Try again.")
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
		JSONError(w, http.StatusBadGateway, "Sol could not change Tailscale access. Check the connection and try again.")
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
