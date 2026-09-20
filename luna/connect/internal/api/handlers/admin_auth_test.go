package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func TestAdminSeedLoginAndMint(t *testing.T) {
	d := testDeps(t)
	config.C.Server.AdminToken = ""
	config.C.Auth.AdminSeedToken = ""
	config.C.Auth.SessionTTLHours = 24
	adm := AdminAuthHandler{Deps: d}
	onb := OnboardingHandler{Deps: d}

	seedReq := httptest.NewRequest(http.MethodPost, "/admin/seed", bytes.NewBufferString(
		`{"email":"admin@example.com","password":"password1234","name":"Max"}`))
	seedReq.RemoteAddr = "127.0.0.1:1234"
	seedRec := httptest.NewRecorder()
	adm.Seed(seedRec, seedReq)
	if seedRec.Code != 200 {
		t.Fatalf("seed %d %s", seedRec.Code, seedRec.Body.String())
	}

	loginReq := httptest.NewRequest(http.MethodPost, "/admin/login", bytes.NewBufferString(
		`{"email":"admin@example.com","password":"password1234"}`))
	loginRec := httptest.NewRecorder()
	adm.Login(loginRec, loginReq)
	if loginRec.Code != 200 {
		t.Fatalf("login %d %s", loginRec.Code, loginRec.Body.String())
	}
	var loginOut map[string]any
	_ = json.Unmarshal(loginRec.Body.Bytes(), &loginOut)
	token, _ := loginOut["token"].(string)
	if token == "" {
		t.Fatal("expected session token")
	}
	adminID, _ := loginOut["id"].(string)
	if adminID != "" && (token == adminID || len(token) > len(adminID) && token[:len(adminID)+1] == adminID+"_") {
		t.Fatalf("session token must be opaque, got prefix of admin id")
	}

	mintReq := httptest.NewRequest(http.MethodPost, "/admin/setup-tokens", bytes.NewBufferString(`{}`))
	mintReq.Header.Set("Authorization", "Bearer "+token)
	mintReq = mintReq.WithContext(WithAdminID(mintReq.Context(), loginOut["id"].(string)))
	mintRec := httptest.NewRecorder()
	onb.AdminMint(mintRec, mintReq)
	if mintRec.Code != 201 {
		t.Fatalf("mint %d %s", mintRec.Code, mintRec.Body.String())
	}

	bulkReq := httptest.NewRequest(http.MethodPost, "/admin/setup-tokens/bulk", bytes.NewBufferString(`{"count":5}`))
	bulkReq.Header.Set("Authorization", "Bearer "+token)
	bulkReq = bulkReq.WithContext(WithAdminID(bulkReq.Context(), loginOut["id"].(string)))
	bulkRec := httptest.NewRecorder()
	onb.AdminMintBulk(bulkRec, bulkReq)
	if bulkRec.Code != 201 {
		t.Fatalf("bulk %d %s", bulkRec.Code, bulkRec.Body.String())
	}
	var bulkOut map[string]any
	_ = json.Unmarshal(bulkRec.Body.Bytes(), &bulkOut)
	if bulkOut["filename"] != "TOKENS" {
		t.Fatalf("filename %v", bulkOut["filename"])
	}
	tokens, _ := bulkOut["tokens"].([]any)
	if len(tokens) != 5 {
		t.Fatalf("count %d", len(tokens))
	}
	for _, raw := range tokens {
		s, _ := raw.(string)
		if !security.IsOfficialShape(security.NormalizeToken(s)) {
			t.Fatalf("token shape %q", s)
		}
		if s != toUpperASCII(s) {
			t.Fatalf("not upper %q", s)
		}
	}
}

func toUpperASCII(s string) string {
	b := []byte(s)
	for i, c := range b {
		if c >= 'a' && c <= 'z' {
			b[i] = c - 32
		}
	}
	return string(b)
}

func TestAdminSeedRejectedRemoteWithoutToken(t *testing.T) {
	d := testDeps(t)
	config.C.Auth.AdminSeedToken = ""
	adm := AdminAuthHandler{Deps: d}
	req := httptest.NewRequest(http.MethodPost, "/admin/seed", bytes.NewBufferString(
		`{"email":"admin@example.com","password":"password1234"}`))
	req.RemoteAddr = "203.0.113.10:9999"
	rec := httptest.NewRecorder()
	adm.Seed(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("want 403 got %d %s", rec.Code, rec.Body.String())
	}
}

func TestAdminSeedRejectedProxiedLoopback(t *testing.T) {
	d := testDeps(t)
	config.C.Auth.AdminSeedToken = ""
	adm := AdminAuthHandler{Deps: d}
	req := httptest.NewRequest(http.MethodPost, "/admin/seed", bytes.NewBufferString(
		`{"email":"admin@example.com","password":"password1234"}`))
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("X-Forwarded-For", "203.0.113.50")
	rec := httptest.NewRecorder()
	adm.Seed(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("proxied seed %d %s", rec.Code, rec.Body.String())
	}
}
