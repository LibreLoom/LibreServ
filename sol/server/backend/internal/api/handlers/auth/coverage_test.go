package auth

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers/testutil"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
)

func TestOIDCHandlerCoverage(t *testing.T) {
	f := testutil.NewFixture(t)
	testutil.SeedApp(t, f, "oidc-app")
	if _, err := f.DB.Exec(`
		INSERT INTO routes
			(id, subdomain, domain, backend, app_id, ssl, enabled, restricted_access, created_at, updated_at)
		VALUES ('route-one', 'oidc', 'example.test', 'http://127.0.0.1:19091',
		        'oidc-app', 0, 1, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`); err != nil {
		t.Fatal(err)
	}
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	authSvc := auth.NewService(f.DB, "coverage-oidc-secret", logger)
	user, err := authSvc.Register(context.Background(), &auth.RegisterRequest{
		Username: "oidc-user",
		Password: "VeryStrongPassword123",
		Email:    "oidc@example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	h := NewOIDCHandler(f.DB, f.Manager, authSvc, "https://issuer.example.test", logger)

	rec := testutil.CallHandler(t, http.MethodGet, "/apps/oidc-app/oidc", "", map[string]string{"instanceId": "oidc-app"}, h.GetOIDCClient)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"configured":false`) {
		t.Fatalf("unconfigured client: %d %s", rec.Code, rec.Body.String())
	}
	clientID, secret, err := ProvisionOIDCClient(f.DB, "oidc-app", "demo", []string{"https://demo.example.test/callback"}, h.issuerURL, logger)
	if err != nil || clientID == "" || secret == "" || len(randomHex(4)) != 8 {
		t.Fatalf("provision client: id=%q secret=%q err=%v", clientID, secret, err)
	}
	rec = testutil.CallHandler(t, http.MethodGet, "/apps/oidc-app/oidc", "", map[string]string{"instanceId": "oidc-app"}, h.GetOIDCClient)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"configured":true`) {
		t.Fatalf("configured client: %d %s", rec.Code, rec.Body.String())
	}
	rec = testutil.CallHandler(t, http.MethodGet, "/apps/oidc-app/oidc/access", "", map[string]string{"instanceId": "oidc-app"}, h.ListAccess)
	if rec.Code != 200 {
		t.Fatalf("empty access: %d", rec.Code)
	}

	for _, body := range []string{"{", `{}`} {
		rec = testutil.CallHandler(t, http.MethodPost, "/access", body, map[string]string{"instanceId": "oidc-app"}, h.GrantAccess)
		if rec.Code != 400 {
			t.Fatalf("invalid grant %q: %d", body, rec.Code)
		}
	}
	rec = testutil.CallHandler(t, http.MethodPost, "/access", fmt.Sprintf(`{"user_id":%q}`, user.ID), map[string]string{"instanceId": "oidc-app"}, h.GrantAccess)
	if rec.Code != 200 {
		t.Fatalf("grant: %d %s", rec.Code, rec.Body.String())
	}
	rec = testutil.CallHandler(t, http.MethodGet, "/access", "", map[string]string{"instanceId": "oidc-app"}, h.ListAccess)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "oidc-user") {
		t.Fatalf("list access: %d %s", rec.Code, rec.Body.String())
	}
	rec = testutil.CallHandler(t, http.MethodDelete, "/access/missing", "", map[string]string{"instanceId": "oidc-app", "userId": "missing"}, h.RevokeAccess)
	if rec.Code != 404 {
		t.Fatalf("revoke missing: %d", rec.Code)
	}
	rec = testutil.CallHandler(t, http.MethodDelete, "/access/"+user.ID, "", map[string]string{"instanceId": "oidc-app", "userId": user.ID}, h.RevokeAccess)
	if rec.Code != 200 {
		t.Fatalf("revoke: %d %s", rec.Code, rec.Body.String())
	}

	rec = testutil.CallHandler(t, http.MethodGet, "/forward", "", nil, h.ForwardAuth)
	if rec.Code != http.StatusFound {
		t.Fatalf("forward no cookie: %d", rec.Code)
	}
	req := httptest.NewRequest(http.MethodGet, "/forward", nil)
	req.AddCookie(&http.Cookie{Name: "libreserv_access", Value: "bad-token"})
	rec = httptest.NewRecorder()
	h.ForwardAuth(rec, req)
	if rec.Code != http.StatusFound {
		t.Fatalf("forward bad cookie: %d", rec.Code)
	}

	if _, err := h.getRouteByDomain("unknown.example.test"); err == nil {
		t.Fatal("expected unknown route")
	}
	rec = testutil.CallHandler(t, http.MethodPut, "/restricted", "{", map[string]string{"instanceId": "oidc-app"}, h.ToggleRestrictedAccess)
	if rec.Code != 400 {
		t.Fatalf("bad toggle: %d", rec.Code)
	}
	rec = testutil.CallHandler(t, http.MethodPut, "/restricted", `{"restricted_access":true}`, map[string]string{"instanceId": "missing"}, h.ToggleRestrictedAccess)
	if rec.Code != 404 {
		t.Fatalf("missing app toggle: %d", rec.Code)
	}
	rec = testutil.CallHandler(t, http.MethodPut, "/restricted", `{"restricted_access":true}`, map[string]string{"instanceId": "oidc-app"}, h.ToggleRestrictedAccess)
	if rec.Code != 200 {
		t.Fatalf("toggle: %d %s", rec.Code, rec.Body.String())
	}
	rec = testutil.CallHandler(t, http.MethodGet, "/restricted", "", map[string]string{"instanceId": "oidc-app"}, h.GetRestrictedAccess)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "true") {
		t.Fatalf("get restricted: %d %s", rec.Code, rec.Body.String())
	}
	rec = testutil.CallHandler(t, http.MethodGet, "/restricted", "", map[string]string{"instanceId": "missing"}, h.GetRestrictedAccess)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "false") {
		t.Fatalf("missing restricted: %d %s", rec.Code, rec.Body.String())
	}
}
