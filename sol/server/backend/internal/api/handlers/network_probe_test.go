package handlers

import (
	"encoding/json"
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

func TestProbeTCPUnreachableSetsJSON503(t *testing.T) {
	h := NewNetworkProbeHandler()
	// RFC 2606 reserved name — fails DNS/dial quickly without waiting on a blackhole IP.
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/?host=invalid.invalid&port=443", nil)
	h.ProbeTCP(rr, req)

	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503 for unreachable probe, got %d body=%s", rr.Code, rr.Body.String())
	}
	if ct := rr.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("expected application/json Content-Type, got %q", ct)
	}
	var body map[string]interface{}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatalf("expected JSON body: %v", err)
	}
	if reachable, _ := body["reachable"].(bool); reachable {
		t.Fatalf("expected reachable=false, body=%v", body)
	}
}
