package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/wifi"
)

// fakeWifi implements wifi.Provider for handler tests without touching any
// radio hardware.
type fakeWifi struct {
	scan       []wifi.Network
	status     wifi.Status
	connectErr error
	connected  wifi.Status
	lastSSID   string
	lastPass   string
}

func (f *fakeWifi) Scan() ([]wifi.Network, error) { return f.scan, nil }
func (f *fakeWifi) Connect(ssid, pass string) error {
	f.lastSSID, f.lastPass = ssid, pass
	if f.connectErr != nil {
		return f.connectErr
	}
	f.status = f.connected
	return nil
}
func (f *fakeWifi) Status() (wifi.Status, error) { return f.status, nil }
func (f *fakeWifi) Forget() error                { return nil }

func TestWifiScanReturnsList(t *testing.T) {
	h := NewWifiHandler(&fakeWifi{scan: []wifi.Network{
		{SSID: "Home Wi-Fi", Signal: -42, Encrypted: true},
		{SSID: "Cafe", Signal: -70, Encrypted: false},
	}})
	req := httptest.NewRequest(http.MethodGet, "/network/wifi/scan", nil)
	w := httptest.NewRecorder()
	h.Scan(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200", w.Code)
	}
	var body struct {
		Networks  []wifi.Network `json:"networks"`
		Available bool           `json:"available"`
	}
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !body.Available || len(body.Networks) != 2 || body.Networks[0].SSID != "Home Wi-Fi" {
		t.Fatalf("unexpected body: %+v", body)
	}
}

func TestWifiConnectRequiresSSID(t *testing.T) {
	h := NewWifiHandler(&fakeWifi{})
	req := httptest.NewRequest(http.MethodPost, "/network/wifi/connect", bytes.NewReader([]byte(`{}`)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.Connect(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("got status %d, want 400", w.Code)
	}
}

func TestWifiConnectSurfacesPlainLanguageError(t *testing.T) {
	f := &fakeWifi{
		status:     wifi.Status{Available: true, State: "SCANNING"},
		connectErr: nil,
		connected:  wifi.Status{Available: true, Connected: true, SSID: "Home Wi-Fi", State: "COMPLETED"},
	}
	h := NewWifiHandler(f)
	body, _ := json.Marshal(map[string]string{"ssid": "Home Wi-Fi", "passphrase": "hunter2"})
	req := httptest.NewRequest(http.MethodPost, "/network/wifi/connect", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.Connect(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("got status %d, want 200: %s", w.Code, w.Body.String())
	}
	if f.lastSSID != "Home Wi-Fi" || f.lastPass != "hunter2" {
		t.Fatalf("provider got ssid=%q pass=%q", f.lastSSID, f.lastPass)
	}
	var resp wifiStatusResponse
	if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !resp.Connected || resp.SSID != "Home Wi-Fi" {
		t.Fatalf("unexpected response: %+v", resp)
	}
}

func TestWifiConnectErrorIs400WithMessage(t *testing.T) {
	f := &fakeWifi{connectErr: &providerErr{msg: "That password didn't work. Check the sticker on your router or modem and try again."}}
	h := NewWifiHandler(f)
	body, _ := json.Marshal(map[string]string{"ssid": "X", "passphrase": "nope"})
	req := httptest.NewRequest(http.MethodPost, "/network/wifi/connect", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.Connect(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("got %d, want 400", w.Code)
	}
	var e map[string]string
	_ = json.NewDecoder(w.Body).Decode(&e)
	if e["error"] != "That password didn't work. Check the sticker on your router or modem and try again." {
		t.Fatalf("unexpected error: %q", e["error"])
	}
}

// providerErr lets the fake return a custom error string.
type providerErr struct{ msg string }

func (e *providerErr) Error() string { return e.msg }
