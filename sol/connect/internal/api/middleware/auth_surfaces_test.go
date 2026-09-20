package middleware

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

func TestCustomerAuthSessionAndVerification(t *testing.T) {
	db := database.OpenTestDB(t)
	accountID := security.GenerateID("acct")
	if _, err := db.Exec(
		`INSERT INTO customer_accounts (id, email, password_hash, plan_id, email_verified)
		 VALUES ($1, $2, 'hash', 'free', FALSE)`, accountID, accountID+"@example.com"); err != nil {
		t.Fatal(err)
	}
	token, err := CreateCustomerSession(db, accountID)
	if err != nil {
		t.Fatalf("CreateCustomerSession: %v", err)
	}

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(GetCustomerDeviceID(r.Context())))
	})
	authenticated := CustomerAuth(db)(next)

	for name, configure := range map[string]func(*http.Request){
		"bearer": func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+token) },
		"cookie": func(r *http.Request) {
			r.AddCookie(&http.Cookie{Name: portalSessionCookie, Value: token})
		},
	} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		configure(req)
		w := httptest.NewRecorder()
		authenticated.ServeHTTP(w, req)
		if w.Code != http.StatusOK || w.Body.String() != accountID {
			t.Fatalf("%s auth = %d: %s", name, w.Code, w.Body.String())
		}
	}

	for token, want := range map[string]int{"": http.StatusUnauthorized, "bad-token": http.StatusUnauthorized} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		authenticated.ServeHTTP(w, req)
		if w.Code != want {
			t.Fatalf("token %q status = %d", token, w.Code)
		}
	}

	ctxReq := httptest.NewRequest(http.MethodGet, "/", nil)
	ctxReq = ctxReq.WithContext(WithCustomerDeviceID(ctxReq.Context(), accountID))
	verifiedGate := RequireVerifiedEmail(db)(next)
	w := httptest.NewRecorder()
	verifiedGate.ServeHTTP(w, ctxReq)
	if w.Code != http.StatusForbidden {
		t.Fatalf("unverified gate = %d", w.Code)
	}
	if _, err := db.Exec(`UPDATE customer_accounts SET email_verified = TRUE WHERE id = $1`, accountID); err != nil {
		t.Fatal(err)
	}
	w = httptest.NewRecorder()
	verifiedGate.ServeHTTP(w, ctxReq)
	if w.Code != http.StatusOK {
		t.Fatalf("verified gate = %d", w.Code)
	}

	missingReq := httptest.NewRequest(http.MethodGet, "/", nil)
	missingReq = missingReq.WithContext(WithCustomerDeviceID(missingReq.Context(), "missing"))
	w = httptest.NewRecorder()
	verifiedGate.ServeHTTP(w, missingReq)
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("missing account gate = %d", w.Code)
	}
}

func TestCustomerAuthExpiredSession(t *testing.T) {
	db := database.OpenTestDB(t)
	accountID := security.GenerateID("acct")
	if _, err := db.Exec(
		`INSERT INTO customer_accounts (id, email, password_hash, plan_id)
		 VALUES ($1, $2, 'hash', 'free')`, accountID, accountID+"@example.com"); err != nil {
		t.Fatal(err)
	}
	token := "expired-token"
	if _, err := db.Exec(
		`INSERT INTO customer_sessions (id, account_id, token_hash, expires_at)
		 VALUES ($1, $2, $3, $4)`,
		security.GenerateID("sess"), accountID, hashToken(token), time.Now().Add(-time.Hour)); err != nil {
		t.Fatal(err)
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	CustomerAuth(db)(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		t.Fatal("expired session reached next handler")
	})).ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "expired") {
		t.Fatalf("expired session = %d: %s", w.Code, w.Body.String())
	}
}

func TestDeviceAuthLifecycle(t *testing.T) {
	db := database.OpenTestDB(t)
	accountID := security.GenerateID("acct")
	deviceID := security.GenerateID("dev")
	keyID := security.GenerateID("lic")
	key := security.GenerateConnectKey()
	if _, err := db.Exec(
		`INSERT INTO customer_accounts (id, email, password_hash, plan_id)
		 VALUES ($1, $2, 'hash', 'free')`, accountID, accountID+"@example.com"); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(
		`INSERT INTO devices (id, account_id, plan_id, is_active) VALUES ($1, $2, 'free', TRUE)`,
		deviceID, accountID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(
		`INSERT INTO connect_keys (id, key_hash, key_prefix, account_id, device_id, status)
		 VALUES ($1, $2, $3, $4, $5, 'active')`,
		keyID, hashToken(key), key[:8], accountID, deviceID); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE devices SET connect_key_id = $1 WHERE id = $2`, keyID, deviceID); err != nil {
		t.Fatal(err)
	}

	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(GetDeviceID(r.Context())))
	})
	authenticated := DeviceAuth(db)(next)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+key)
	w := httptest.NewRecorder()
	authenticated.ServeHTTP(w, req)
	if w.Code != http.StatusOK || w.Body.String() != deviceID {
		t.Fatalf("device auth = %d: %s", w.Code, w.Body.String())
	}

	for token, wantText := range map[string]string{"": "missing", "wrong": "invalid"} {
		req = httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = "192.0.2.44:1000"
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		w = httptest.NewRecorder()
		authenticated.ServeHTTP(w, req)
		if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), wantText) {
			t.Fatalf("device token %q = %d: %s", token, w.Code, w.Body.String())
		}
	}

	if _, err := db.Exec(`UPDATE devices SET is_active = FALSE WHERE id = $1`, deviceID); err != nil {
		t.Fatal(err)
	}
	req = httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+key)
	w = httptest.NewRecorder()
	authenticated.ServeHTTP(w, req)
	if w.Code != http.StatusUnauthorized || !strings.Contains(w.Body.String(), "not active") {
		t.Fatalf("inactive device = %d: %s", w.Code, w.Body.String())
	}
	if GetDeviceID(WithDeviceID(context.Background(), "direct-device")) != "direct-device" {
		t.Fatal("WithDeviceID/GetDeviceID mismatch")
	}
}

func TestAdminSessionHelpers(t *testing.T) {
	db := database.OpenTestDB(t)
	hash := "hash"
	adminID := security.GenerateID("admin")
	if _, err := db.Exec(
		`INSERT INTO admin_accounts (id, email, password_hash) VALUES ($1, $2, $3)`,
		adminID, adminID+"@example.com", hash); err != nil {
		t.Fatal(err)
	}
	token, err := CreateAdminSession(db, adminID)
	if err != nil {
		t.Fatalf("CreateAdminSession: %v", err)
	}
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	AdminAuth(db)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(GetAdminID(r.Context())))
	})).ServeHTTP(w, req)
	if w.Code != http.StatusOK || w.Body.String() != adminID {
		t.Fatalf("admin session = %d: %s", w.Code, w.Body.String())
	}
	if GetAdminID(WithAdminID(context.Background(), "direct-admin")) != "direct-admin" {
		t.Fatal("WithAdminID/GetAdminID mismatch")
	}
}

func TestHTTPUtilityMiddleware(t *testing.T) {
	called := 0
	next := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called++
		w.Header().Set("X-Test", "yes")
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte("next"))
	})
	spa := func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("spa"))
	}
	handler := Logger(SPAFallback(spa)(next))

	req := httptest.NewRequest(http.MethodGet, "/admin/deep-link", nil)
	req.Header.Set("Accept", "text/html,application/xhtml+xml")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Body.String() != "spa" || called != 0 {
		t.Fatalf("SPA fallback = %q, called=%d", w.Body.String(), called)
	}
	req = httptest.NewRequest(http.MethodGet, "/api", nil)
	req.Header.Set("Accept", "application/json")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != http.StatusCreated || called != 1 {
		t.Fatalf("API pass-through = %d, called=%d", w.Code, called)
	}

	panicHandler := Recoverer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {
		panic("test panic")
	}))
	w = httptest.NewRecorder()
	panicHandler.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/", nil))
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("recoverer = %d", w.Code)
	}

	oldBase := config.C.Server.BaseURL
	t.Cleanup(func() { config.C.Server.BaseURL = oldBase })
	config.C.Server.BaseURL = "https://connect.example"
	logout := httptest.NewRecorder()
	PortalLogout(logout, httptest.NewRequest(http.MethodPost, "/logout", nil))
	if logout.Code != http.StatusOK || !strings.Contains(logout.Header().Get("Set-Cookie"), "Max-Age=0") {
		t.Fatalf("logout = %d, cookie=%q", logout.Code, logout.Header().Get("Set-Cookie"))
	}
}
