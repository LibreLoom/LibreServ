package middleware

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/constants"
)

func TestLeakyBucketRefillAndExhaustion(t *testing.T) {
	bucket := NewLeakyBucket(2, 60)
	if !bucket.Allow() || !bucket.Allow() {
		t.Fatal("initial burst tokens were not available")
	}
	if bucket.Allow() {
		t.Fatal("exhausted bucket allowed another request")
	}
	bucket.mu.Lock()
	bucket.lastRef = time.Now().Add(-2 * time.Second)
	bucket.mu.Unlock()
	if !bucket.Allow() {
		t.Fatal("bucket did not refill")
	}
	bucket.mu.Lock()
	bucket.tokens = 100
	bucket.lastRef = time.Now().Add(-time.Second)
	bucket.mu.Unlock()
	if !bucket.Allow() {
		t.Fatal("bucket did not cap and retain refill tokens")
	}
}

func TestRealIPTrustedAndUntrustedPeers(t *testing.T) {
	handler := RealIP()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(r.RemoteAddr))
	}))
	tests := []struct {
		name       string
		remote     string
		forwarded  string
		realIP     string
		wantRemote string
	}{
		{"untrusted ignores headers", "203.0.113.10:1234", "198.51.100.5", "198.51.100.6", "203.0.113.10"},
		{"trusted uses forwarded client", "127.0.0.1:1234", "198.51.100.5, 127.0.0.2", "", "198.51.100.5"},
		{"trusted skips invalid forwarded", "127.0.0.1:1234", "invalid, 198.51.100.7", "", "198.51.100.7"},
		{"trusted falls back to real IP", "127.0.0.1:1234", "", "198.51.100.8", "198.51.100.8"},
		{"trusted falls back to direct", "127.0.0.1:1234", "", "", "127.0.0.1"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			request.RemoteAddr = tc.remote
			request.Header.Set("X-Forwarded-For", tc.forwarded)
			request.Header.Set("X-Real-IP", tc.realIP)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			if recorder.Body.String() != tc.wantRemote {
				t.Fatalf("remote address = %q, want %q", recorder.Body.String(), tc.wantRemote)
			}
		})
	}
	if got := parseIPPort("not-an-ip"); got != nil {
		t.Fatalf("invalid remote parsed as %v", got)
	}
	if got := parseIPPort("192.0.2.2"); got == nil || got.String() != "192.0.2.2" {
		t.Fatalf("plain IP parsed as %v", got)
	}
}

func TestSecurityHeadersProductionAndDevelopment(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	for _, tc := range []struct {
		name    string
		handler http.Handler
		host    string
		hsts    bool
		dev     bool
	}{
		{"production domain", SecurityHeaders()(next), "server.example.test", true, false},
		{"production localhost", SecurityHeaders()(next), "localhost:8080", false, false},
		{"development", DevSecurityHeaders()(next), "server.example.test", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "http://"+tc.host+"/", nil)
			recorder := httptest.NewRecorder()
			tc.handler.ServeHTTP(recorder, request)
			if recorder.Code != http.StatusNoContent ||
				recorder.Header().Get("X-Content-Type-Options") != "nosniff" ||
				recorder.Header().Get("X-Frame-Options") != "DENY" {
				t.Fatalf("missing security headers: status=%d headers=%#v", recorder.Code, recorder.Header())
			}
			if got := recorder.Header().Get("Strict-Transport-Security") != ""; got != tc.hsts {
				t.Fatalf("HSTS presence = %v, want %v", got, tc.hsts)
			}
			if got := recorder.Header().Get("X-Robots-Tag") != ""; got != tc.dev {
				t.Fatalf("robots header presence = %v, want %v", got, tc.dev)
			}
		})
	}
}

func TestRequireRoleAndContextHelpers(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	handler := RequireRole("operator")(next)
	cases := []struct {
		name   string
		user   *User
		status int
	}{
		{"no user", nil, http.StatusUnauthorized},
		{"wrong role", &User{ID: "one", Role: "user"}, http.StatusForbidden},
		{"required role", &User{ID: "two", Role: "operator"}, http.StatusNoContent},
		{"admin override", &User{ID: "three", Role: "admin"}, http.StatusNoContent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			if tc.user != nil {
				ctx := context.WithValue(request.Context(), UserContextKey, tc.user)
				ctx = context.WithValue(ctx, UserIDContextKey, tc.user.ID)
				ctx = context.WithValue(ctx, AuthMethodContextKey, "session")
				request = request.WithContext(ctx)
			}
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)
			if recorder.Code != tc.status {
				t.Fatalf("status = %d, want %d", recorder.Code, tc.status)
			}
			if tc.user != nil {
				if id, ok := GetUserID(request.Context()); !ok || id != tc.user.ID {
					t.Fatalf("GetUserID = %q, %v", id, ok)
				}
				if GetAuthMethod(request.Context()) != "session" {
					t.Fatal("auth method missing")
				}
			}
		})
	}
	if id, ok := GetUserID(context.Background()); ok || id != "" {
		t.Fatalf("empty GetUserID = %q, %v", id, ok)
	}
}

func TestCSRFTokensAndMiddlewareBranches(t *testing.T) {
	const secret = "csrf-secret"
	token, err := GenerateCSRF(secret, "user-1")
	if err != nil {
		t.Fatal(err)
	}
	if !validateCSRF(secret, "user-1", token) {
		t.Fatal("generated CSRF token did not validate")
	}
	if validateCSRF(secret, "other-user", token) ||
		validateCSRF(secret, "user-1", "malformed") ||
		validateCSRF(secret, "user-1", "sig|not-a-time|nonce") {
		t.Fatal("invalid CSRF token validated")
	}
	parts := strings.Split(token, "|")
	expiredTimestamp := strconv.FormatInt(time.Now().Add(-constants.CSRFTokenValidityPeriod-time.Hour).Unix(), 10)
	if validateCSRF(secret, "user-1", parts[0]+"|"+expiredTimestamp+"|"+parts[2]) {
		t.Fatal("expired CSRF token validated")
	}

	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	userCtx := context.WithValue(context.Background(), UserContextKey, &User{ID: "user-1"})
	apiCtx := context.WithValue(userCtx, AuthMethodContextKey, "api_token")
	cases := []struct {
		name   string
		secret string
		method string
		ctx    context.Context
		token  string
		want   int
	}{
		{"empty secret read allowed", "", http.MethodGet, context.Background(), "", http.StatusNoContent},
		{"empty secret write denied", "", http.MethodPost, context.Background(), "", http.StatusForbidden},
		{"read allowed", secret, http.MethodGet, context.Background(), "", http.StatusNoContent},
		{"API token write allowed", secret, http.MethodPost, apiCtx, "", http.StatusNoContent},
		{"session user required", secret, http.MethodPost, context.Background(), "", http.StatusUnauthorized},
		{"token required", secret, http.MethodPost, userCtx, "", http.StatusForbidden},
		{"invalid token denied", secret, http.MethodPost, userCtx, "invalid", http.StatusForbidden},
		{"valid token allowed", secret, http.MethodPost, userCtx, token, http.StatusNoContent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(tc.method, "/", nil).WithContext(tc.ctx)
			request.Header.Set("X-CSRF-Token", tc.token)
			recorder := httptest.NewRecorder()
			CSRF(tc.secret)(next).ServeHTTP(recorder, request)
			if recorder.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, tc.want, recorder.Body.String())
			}
		})
	}
}

type coverageSetupState struct {
	complete bool
	token    string
	err      error
}

func (s coverageSetupState) IsComplete(context.Context) bool { return s.complete }
func (s coverageSetupState) SetupToken(context.Context) (string, error) {
	return s.token, s.err
}

func TestSetupAccessBranches(t *testing.T) {
	next := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	cases := []struct {
		name     string
		provider SetupStateProvider
		remote   string
		token    string
		want     int
	}{
		{"nil provider", nil, "203.0.113.1:1234", "", http.StatusNoContent},
		{"complete setup", coverageSetupState{complete: true}, "203.0.113.1:1234", "", http.StatusNoContent},
		{"local setup", coverageSetupState{}, "127.0.0.1:1234", "", http.StatusNoContent},
		{"missing stored token", coverageSetupState{}, "203.0.113.1:1234", "", http.StatusForbidden},
		{"token lookup error", coverageSetupState{err: errors.New("failed")}, "203.0.113.1:1234", "", http.StatusForbidden},
		{"wrong token", coverageSetupState{token: "ABC123"}, "203.0.113.1:1234", "wrong", http.StatusForbidden},
		{"case-insensitive token", coverageSetupState{token: "ABC123"}, "203.0.113.1:1234", " abc123 ", http.StatusNoContent},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodPost, "/setup", nil)
			request.RemoteAddr = tc.remote
			request.Header.Set("X-Setup-Token", tc.token)
			recorder := httptest.NewRecorder()
			SetupAccess(tc.provider)(next).ServeHTTP(recorder, request)
			if recorder.Code != tc.want {
				t.Fatalf("status = %d, want %d: %s", recorder.Code, tc.want, recorder.Body.String())
			}
		})
	}

	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.RemoteAddr = "127.0.0.1:1234"
	request.Header.Set("X-Forwarded-For", "invalid, 198.51.100.10")
	if got := clientIP(request); got == nil || got.String() != "198.51.100.10" {
		t.Fatalf("proxied client IP = %v", got)
	}
	request.RemoteAddr = "invalid"
	if clientIP(request) != nil || isLocalSetupRequest(request) {
		t.Fatal("invalid remote address treated as local")
	}
}
