package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/wifi"
)

// WifiHandler serves the wireless setup API. It delegates to a wifi.Provider
// so the same routes work with a real wpa_supplicant radio, a no-op when no
// wireless interface exists, or a fake in tests. Passphrases are accepted on
// the way in, handed to the provider once, and never logged or returned.
type WifiHandler struct {
	provider wifi.Provider
}

// NewWifiHandler creates a WifiHandler backed by the given provider.
func NewWifiHandler(provider wifi.Provider) *WifiHandler {
	return &WifiHandler{provider: provider}
}

// wifiStatusResponse is the JSON shape for GET /network/wifi/status (and the
// setup-wizard /setup/wifi/status twin). It carries the provider's own view
// plus the Ethernet carrier state, which the connection-check step needs to
// decide "Wi-Fi optional" vs "Wi-Fi required".
type wifiStatusResponse struct {
	Available         bool   `json:"available"`
	Connected         bool   `json:"connected"`
	SSID              string `json:"ssid,omitempty"`
	IPAddress         string `json:"ip_address,omitempty"`
	State             string `json:"state"`
	EthernetConnected bool   `json:"ethernet_connected"`
}

// status returns the provider status merged with the Ethernet carrier state.
func (h *WifiHandler) status() wifiStatusResponse {
	st, _ := h.provider.Status()
	return wifiStatusResponse{
		Available:         st.Available,
		Connected:         st.Connected,
		SSID:              st.SSID,
		IPAddress:         st.IPAddress,
		State:             st.State,
		EthernetConnected: wifi.EthernetConnected(),
	}
}

// GetStatus handles GET /network/wifi/status.
func (h *WifiHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	JSON(w, http.StatusOK, h.status())
}

// Scan handles GET /network/wifi/scan.
func (h *WifiHandler) Scan(w http.ResponseWriter, r *http.Request) {
	networks, err := h.provider.Scan()
	if err != nil {
		// Still return an empty list with a 200 — the UI shows a plain
		// "Wi-Fi isn't available here" line instead of a hard error.
		JSON(w, http.StatusOK, map[string]interface{}{"networks": []wifi.Network{}, "available": false})
		return
	}
	JSON(w, http.StatusOK, map[string]interface{}{"networks": networks, "available": true})
}

// ConnectRequest is the body for POST /network/wifi/connect.
type ConnectRequest struct {
	SSID       string `json:"ssid"`
	Passphrase string `json:"passphrase"`
}

// wifiConnectMessage turns a provider error into plain language. The provider
// may return technical detail ("the Wi-Fi tool said: <stderr>"); the user
// should get the actionable line instead, while the real detail stays in logs.
func wifiConnectMessage(err error) string {
	lower := strings.ToLower(err.Error())
	switch {
	case strings.Contains(lower, "password"):
		return "That password didn't work. Check the sticker on your internet box and try again."
	case strings.Contains(lower, "available") || strings.Contains(lower, "not available"):
		return "Wi-Fi isn't available on this device. Plug in an adapter or use the cable."
	default:
		return "We couldn't connect to that network. Please try again."
	}
}

// Connect handles POST /network/wifi/connect.
func (h *WifiHandler) Connect(w http.ResponseWriter, r *http.Request) {
	var req ConnectRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't read that request. Please try again.")
		return
	}
	if req.SSID == "" {
		JSONError(w, http.StatusBadRequest, "Pick a network to connect to.")
		return
	}
	if err := h.provider.Connect(req.SSID, req.Passphrase); err != nil {
		slog.Warn("wifi connect failed", "ssid", req.SSID, "error", err)
		JSONError(w, http.StatusBadRequest, wifiConnectMessage(err))
		return
	}
	JSON(w, http.StatusOK, h.status())
}

// Forget handles POST /network/wifi/forget.
func (h *WifiHandler) Forget(w http.ResponseWriter, r *http.Request) {
	if err := h.provider.Forget(); err != nil {
		slog.Warn("wifi forget failed", "error", err)
		JSONError(w, http.StatusBadRequest, "We couldn't forget that network. Please try again.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
