package handlers

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestNetworkProbeHandlersValidation(t *testing.T) {
	h := NewNetworkProbeHandler()

	// Missing host
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/?port=80", nil)
	h.ProbeTCP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rr.Code)
	}

	// Invalid port
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/?host=example.com&port=99999", nil)
	h.ProbeTCP(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rr.Code)
	}

	// DNS missing
	rr = httptest.NewRecorder()
	req = httptest.NewRequest(http.MethodGet, "/dns", nil)
	h.DNS(rr, req)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", rr.Code)
	}
}
