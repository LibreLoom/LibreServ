package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func seedAdminSession(t *testing.T, h AdminAuthHandler) (adminID, token string) {
	t.Helper()
	config.C.Auth.AdminSeedToken = ""
	config.C.Auth.SessionTTLHours = 24
	seedReq := httptest.NewRequest(http.MethodPost, "/admin/seed", bytes.NewBufferString(
		`{"email":"staff@example.com","password":"password1234","name":"Staff"}`))
	seedReq.RemoteAddr = "127.0.0.1:9"
	seedRec := httptest.NewRecorder()
	h.Seed(seedRec, seedReq)
	if seedRec.Code != 200 {
		t.Fatalf("seed %d %s", seedRec.Code, seedRec.Body.String())
	}
	loginReq := httptest.NewRequest(http.MethodPost, "/admin/login", bytes.NewBufferString(
		`{"email":"staff@example.com","password":"password1234"}`))
	loginRec := httptest.NewRecorder()
	h.Login(loginRec, loginReq)
	if loginRec.Code != 200 {
		t.Fatalf("login %d %s", loginRec.Code, loginRec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(loginRec.Body.Bytes(), &out)
	return out["id"].(string), out["token"].(string)
}

func TestAdminConsoleStatsAccountsDevices(t *testing.T) {
	d := testDeps(t)
	config.C.Server.PublicZone = "luna.servers.example.test"
	adm := AdminAuthHandler{Deps: d}
	console := AdminConsoleHandler{Deps: d}
	_, _ = seedAdminSession(t, adm)

	_, _ = d.DB.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, created_at)
VALUES ('acct_1', 'cust@example.com', 'x', 1, 'active', ?)`, time.Now().Unix())
	_, _ = d.DB.Exec(`INSERT INTO devices (id, account_id, token_hash, name, subdomain, local_port, created_at)
VALUES ('dev_1', 'acct_1', ?, 'Kitchen', 'kitchen', 8090, ?)`, security.HashToken("tok"), time.Now().Unix())
	_, _ = d.DB.Exec(`INSERT INTO issued_tokens (id, token_hash, kind, status, created_at)
VALUES ('tok_1', ?, 'official', 'issued', ?)`, security.HashToken("AAAA"), time.Now().Unix())
	_, _ = d.DB.Exec(`INSERT INTO backup_objects (id, account_id, device_id, relative_path, size, updated_at)
VALUES ('obj_1', 'acct_1', 'dev_1', 'a.jpg', 1500, ?)`, time.Now().Unix())

	statsRec := httptest.NewRecorder()
	console.Stats(statsRec, httptest.NewRequest(http.MethodGet, "/admin/stats", nil))
	if statsRec.Code != 200 {
		t.Fatalf("stats %d %s", statsRec.Code, statsRec.Body.String())
	}
	var stats map[string]any
	_ = json.Unmarshal(statsRec.Body.Bytes(), &stats)
	if int(stats["accounts"].(float64)) < 1 || int(stats["devices"].(float64)) < 1 {
		t.Fatalf("stats %+v", stats)
	}

	devRec := httptest.NewRecorder()
	console.Devices(devRec, httptest.NewRequest(http.MethodGet, "/admin/devices", nil))
	if devRec.Code != 200 {
		t.Fatalf("devices %d %s", devRec.Code, devRec.Body.String())
	}
	var devicesOut map[string]any
	_ = json.Unmarshal(devRec.Body.Bytes(), &devicesOut)
	devs := devicesOut["devices"].([]any)
	if len(devs) < 1 {
		t.Fatal("expected device")
	}
	first := devs[0].(map[string]any)
	if first["account_email"] != "cust@example.com" {
		t.Fatalf("email %v", first["account_email"])
	}
	if first["hostname"] != "kitchen.luna.servers.example.test" {
		t.Fatalf("hostname %v", first["hostname"])
	}

	acctRec := httptest.NewRecorder()
	console.Accounts(acctRec, httptest.NewRequest(http.MethodGet, "/admin/accounts", nil))
	if acctRec.Code != 200 {
		t.Fatalf("accounts %d %s", acctRec.Code, acctRec.Body.String())
	}
	var acctsOut map[string]any
	_ = json.Unmarshal(acctRec.Body.Bytes(), &acctsOut)
	accts := acctsOut["accounts"].([]any)
	found := false
	for _, raw := range accts {
		a := raw.(map[string]any)
		if a["email"] == "cust@example.com" && int(a["device_count"].(float64)) == 1 {
			found = true
		}
	}
	if !found {
		t.Fatalf("accounts %+v", accts)
	}
}

func TestAdminPasswordAndCRUD(t *testing.T) {
	d := testDeps(t)
	adm := AdminAuthHandler{Deps: d}
	adminID, _ := seedAdminSession(t, adm)
	ctx := WithAdminID(context.Background(), adminID)

	pwdReq := httptest.NewRequest(http.MethodPost, "/admin/password", bytes.NewBufferString(
		`{"current_password":"password1234","new_password":"password5678"}`))
	pwdReq = pwdReq.WithContext(ctx)
	pwdRec := httptest.NewRecorder()
	adm.ChangePassword(pwdRec, pwdReq)
	if pwdRec.Code != 200 {
		t.Fatalf("password %d %s", pwdRec.Code, pwdRec.Body.String())
	}

	createReq := httptest.NewRequest(http.MethodPost, "/admin/admins", bytes.NewBufferString(
		`{"email":"other@example.com","password":"password1234","name":"Other"}`))
	createReq = createReq.WithContext(ctx)
	createRec := httptest.NewRecorder()
	adm.CreateAdmin(createRec, createReq)
	if createRec.Code != 201 {
		t.Fatalf("create %d %s", createRec.Code, createRec.Body.String())
	}
	var created map[string]any
	_ = json.Unmarshal(createRec.Body.Bytes(), &created)
	otherID := created["id"].(string)

	listRec := httptest.NewRecorder()
	adm.ListAdmins(listRec, httptest.NewRequest(http.MethodGet, "/admin/admins", nil).WithContext(ctx))
	if listRec.Code != 200 {
		t.Fatalf("list %d %s", listRec.Code, listRec.Body.String())
	}

	delReq := httptest.NewRequest(http.MethodDelete, "/admin/admins/"+otherID, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("adminID", otherID)
	delReq = delReq.WithContext(context.WithValue(ctx, chi.RouteCtxKey, rctx))
	delRec := httptest.NewRecorder()
	adm.DeleteAdmin(delRec, delReq)
	if delRec.Code != 200 {
		t.Fatalf("delete %d %s", delRec.Code, delRec.Body.String())
	}
}

func TestAdminSetupTokensListAndRevoke(t *testing.T) {
	d := testDeps(t)
	adm := AdminAuthHandler{Deps: d}
	console := AdminConsoleHandler{Deps: d}
	onb := OnboardingHandler{Deps: d}
	adminID, _ := seedAdminSession(t, adm)
	ctx := WithAdminID(context.Background(), adminID)
	config.C.Server.AdminToken = "admin-test-token"

	mintReq := httptest.NewRequest(http.MethodPost, "/admin/setup-tokens", nil)
	mintReq.Header.Set("Authorization", "Bearer admin-test-token")
	mintReq = mintReq.WithContext(ctx)
	mintRec := httptest.NewRecorder()
	onb.AdminMint(mintRec, mintReq)
	if mintRec.Code != 201 {
		t.Fatalf("mint %d %s", mintRec.Code, mintRec.Body.String())
	}
	var minted map[string]any
	_ = json.Unmarshal(mintRec.Body.Bytes(), &minted)
	tokID := minted["id"].(string)

	listRec := httptest.NewRecorder()
	console.SetupTokens(listRec, httptest.NewRequest(http.MethodGet, "/admin/setup-tokens", nil).WithContext(ctx))
	if listRec.Code != 200 {
		t.Fatalf("list %d %s", listRec.Code, listRec.Body.String())
	}
	var listed map[string]any
	_ = json.Unmarshal(listRec.Body.Bytes(), &listed)
	tokens := listed["tokens"].([]any)
	if len(tokens) < 1 {
		t.Fatal("expected tokens")
	}

	delReq := httptest.NewRequest(http.MethodDelete, "/admin/setup-tokens/"+tokID, nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("tokenID", tokID)
	delReq = delReq.WithContext(context.WithValue(ctx, chi.RouteCtxKey, rctx))
	delRec := httptest.NewRecorder()
	console.RevokeSetupToken(delRec, delReq)
	if delRec.Code != 200 {
		t.Fatalf("revoke %d %s", delRec.Code, delRec.Body.String())
	}
	var status string
	_ = d.DB.QueryRow(`SELECT status FROM issued_tokens WHERE id = ?`, tokID).Scan(&status)
	if status != "revoked" {
		t.Fatalf("status %q", status)
	}
}
