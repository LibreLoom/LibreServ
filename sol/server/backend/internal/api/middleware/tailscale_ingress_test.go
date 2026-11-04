package middleware

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestTailscaleIngressValidatesAuthorityAndNeverGrantsLocalSetup(t *testing.T) {
	seen := false
	handler := TailscaleIngress(func() string { return "https://sol.example.ts.net" }, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen = true
		if !IsTailscaleIngress(r) || isLocalSetupRequest(r) || r.Host != "sol.example.ts.net" {
			t.Errorf("unsafe ingress: host %q", r.Host)
		}
		for _, name := range []string{"Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto", "X-Real-IP", "Cf-Connecting-Ip"} {
			if r.Header.Get(name) != "" {
				t.Errorf("%s survived ingress", name)
			}
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	req := httptest.NewRequest("POST", "http://localhost/setup", nil)
	req.Header.Set("X-Forwarded-For", "127.0.0.1")
	req.Header.Set("X-Forwarded-Host", "sol.example.ts.net")
	req.Header.Set("X-Real-IP", "192.168.1.2")
	req.Header.Set("Forwarded", "for=192.168.1.2")
	req.Header.Set("X-Forwarded-Proto", "http")
	req.Header.Set("Cf-Connecting-Ip", "192.168.1.3")
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent || !seen {
		t.Fatalf("valid status %d", rec.Code)
	}
	for _, mutation := range []func(*http.Request){
		func(r *http.Request) { r.Header.Set("X-Forwarded-Host", "other.example") },
		func(r *http.Request) { r.Header.Add("X-Forwarded-For", "192.0.2.1") },
		func(r *http.Request) { r.Header.Set("X-Forwarded-For", "192.0.2.1, 192.0.2.2") },
	} {
		req := httptest.NewRequest("GET", "http://localhost/", nil)
		req.Header.Set("X-Forwarded-For", "100.64.0.1")
		req.Header.Set("X-Forwarded-Host", "sol.example.ts.net")
		mutation(req)
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, req)
		if rec.Code != http.StatusBadGateway {
			t.Errorf("unsafe request status %d", rec.Code)
		}
	}
}
