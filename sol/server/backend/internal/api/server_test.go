package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewServerRouterSmoke(t *testing.T) {
	router, _ := testServer(t)

	paths := []string{
		"/health",
		"/health/live",
		"/health/ready",
		"/api/version",
		"/api/v1/setup/status",
		"/api/v1/catalog/apps",
		"/api/v1/network/probe/public-ip",
		"/api/v1/auth/login",
	}
	for _, path := range paths {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodGet, path, nil)
		router.ServeHTTP(rec, req)
		if rec.Code >= 500 {
			t.Fatalf("%s => %d %s", path, rec.Code, rec.Body.String())
		}
	}

	// Unauthenticated POSTs should not 500.
	for _, path := range []string{"/api/v1/auth/login", "/api/v1/auth/refresh"} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, path, strings.NewReader(`{}`))
		req.Header.Set("Content-Type", "application/json")
		router.ServeHTTP(rec, req)
		if rec.Code >= 500 {
			t.Fatalf("POST %s => %d %s", path, rec.Code, rec.Body.String())
		}
	}
}
