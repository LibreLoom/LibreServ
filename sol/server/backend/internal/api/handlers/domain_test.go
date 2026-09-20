package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

func newTestDomainHandler(t *testing.T) *DomainHandler {
	t.Helper()
	db, err := database.Open(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	t.Cleanup(func() { db.Close() })
	if err := db.Migrate(); err != nil {
		t.Fatalf("Migrate: %v", err)
	}
	return NewDomainHandler(network.NewDNSProviderManager(db), nil, nil)
}

func doConfigure(t *testing.T, h *DomainHandler, payload map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	body, _ := json.Marshal(payload)
	req := httptest.NewRequest(http.MethodPut, "/api/v1/settings/domain", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.Configure(w, req)
	return w
}

func TestDomainConfigureValidation(t *testing.T) {
	h := newTestDomainHandler(t)

	tests := []struct {
		name    string
		payload map[string]string
		want    int
	}{
		{"empty payload", map[string]string{}, http.StatusBadRequest},
		{"unsupported provider", map[string]string{"provider": "route53", "domain": "example.com"}, http.StatusBadRequest},
		{"cloudflare missing token/email", map[string]string{"provider": "cloudflare", "domain": "example.com"}, http.StatusBadRequest},
		{"rfc2136 missing fields", map[string]string{"provider": "rfc2136", "domain": "example.com"}, http.StatusBadRequest},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w := doConfigure(t, h, tt.payload)
			if w.Code != tt.want {
				t.Errorf("status = %d, want %d (body=%s)", w.Code, tt.want, w.Body.String())
			}
		})
	}
}

func TestDomainStatusUnconfigured(t *testing.T) {
	h := newTestDomainHandler(t)
	req := httptest.NewRequest(http.MethodGet, "/api/v1/settings/domain", nil)
	w := httptest.NewRecorder()
	h.Status(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var body map[string]any
	if err := json.NewDecoder(w.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body["configured"] != false {
		t.Errorf("configured = %v, want false", body["configured"])
	}
}
