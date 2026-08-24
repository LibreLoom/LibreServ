package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/setuphub"
)

func testOnboarding(t *testing.T) (OnboardingHandler, AccountHandler, DeviceHandler) {
	t.Helper()
	d := testDeps(t)
	d.Hub = setuphub.New()
	config.C.Server.AdminToken = "admin-test-token"
	return OnboardingHandler{Deps: d}, AccountHandler{Deps: d}, DeviceHandler{Deps: d}
}

func mintOfficial(t *testing.T, h OnboardingHandler) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/admin/setup-tokens", nil)
	req.Header.Set("Authorization", "Bearer admin-test-token")
	rec := httptest.NewRecorder()
	h.AdminMint(rec, req)
	if rec.Code != 201 {
		t.Fatalf("mint %d %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	return out["token"].(string)
}

func registerAccount(t *testing.T, acct AccountHandler, email string) *http.Cookie {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/account/register", bytes.NewBufferString(`{"email":"`+email+`","password":"password1"}`))
	rec := httptest.NewRecorder()
	acct.Register(rec, req)
	if rec.Code != 201 {
		t.Fatalf("acct %d %s", rec.Code, rec.Body.String())
	}
	return rec.Result().Cookies()[0]
}

func withAccount(acct AccountHandler, h http.HandlerFunc, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	acct.AccountAuth(h).ServeHTTP(rec, req)
	return rec
}

func helloWS(t *testing.T, srv *httptest.Server, token string) *websocket.Conn {
	t.Helper()
	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/v1/setup/ws"
	c, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.WriteJSON(map[string]any{"type": "hello", "token": token, "local_port": 8090, "source": "anonymous"}); err != nil {
		t.Fatal(err)
	}
	return c
}

func readType(t *testing.T, c *websocket.Conn, want string) map[string]any {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(3 * time.Second))
	var msg map[string]any
	if err := c.ReadJSON(&msg); err != nil {
		t.Fatalf("read %s: %v", want, err)
	}
	if msg["type"] != want {
		t.Fatalf("got type %v want %s (%v)", msg["type"], want, msg)
	}
	return msg
}

func TestRegisterIsGone(t *testing.T) {
	_, _, dev := testOnboarding(t)
	req := httptest.NewRequest(http.MethodPost, "/register", bytes.NewBufferString(`{"subdomain":"photos"}`))
	rec := httptest.NewRecorder()
	dev.Register(rec, req)
	if rec.Code != http.StatusGone {
		t.Fatalf("register should be gone, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestUnknownWSDropped(t *testing.T) {
	onb, _, _ := testOnboarding(t)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/setup/ws", onb.SetupWS)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := helloWS(t, srv, "DEAD00")
	defer c.Close()
	msg := readType(t, c, "error")
	if msg["message"] != "unknown" {
		t.Fatalf("want unknown, got %v", msg)
	}
}

func TestWaitingRoomCodeBeforeHello(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	token := mintOfficial(t, onb)
	cookie := registerAccount(t, acct, "wait@b.co")

	bind := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+token+`"}`))
	bind.AddCookie(cookie)
	bind.RemoteAddr = "203.0.113.10:9"
	rec := httptest.NewRecorder()
	onb.Bind(rec, bind)
	if rec.Code != 200 {
		t.Fatalf("bind %d %s", rec.Code, rec.Body.String())
	}
	var bound map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &bound)
	if bound["status"] != "waiting_device" {
		t.Fatalf("status %v", bound)
	}
	if !strings.Contains(bound["message"].(string), "cable") {
		t.Fatalf("plug copy missing: %v", bound["message"])
	}

	var n int
	_ = onb.DB.QueryRow(`SELECT COUNT(*) FROM devices`).Scan(&n)
	if n != 0 {
		t.Fatalf("tunnel/device created before name: %d", n)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/setup/ws", onb.SetupWS)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := helloWS(t, srv, token)
	defer c.Close()
	readType(t, c, "accepted")
	readType(t, c, "attached")

	nameReq := httptest.NewRequest(http.MethodPost, "/onboarding/name", bytes.NewBufferString(`{"subdomain":"photos"}`))
	nameReq.AddCookie(cookie)
	nameReq.AddCookie(rec.Result().Cookies()[0])
	nrec := httptest.NewRecorder()
	acct.AccountAuth(http.HandlerFunc(onb.Name)).ServeHTTP(nrec, nameReq)
	if nrec.Code != 201 {
		t.Fatalf("name %d %s", nrec.Code, nrec.Body.String())
	}
	claimed := readType(t, c, "claimed")
	if claimed["setup_secret"] == "" || claimed["hostname"] != "photos.luna.servers.libreloom.org" {
		t.Fatalf("claimed %v", claimed)
	}
	if claimed["tunnel_token"] == "" {
		t.Fatalf("missing tunnel token")
	}
}

func TestNoTunnelBeforeSubdomain(t *testing.T) {
	onb, _, _ := testOnboarding(t)
	token := mintOfficial(t, onb)
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/setup/ws", onb.SetupWS)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := helloWS(t, srv, token)
	defer c.Close()
	readType(t, c, "accepted")
	readType(t, c, "waiting_for_website")
	var n int
	_ = onb.DB.QueryRow(`SELECT COUNT(*) FROM devices`).Scan(&n)
	if n != 0 {
		t.Fatal("device row before subdomain")
	}
}

func TestOSSMintThenHello(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	cookie := registerAccount(t, acct, "oss@b.co")

	mint := httptest.NewRequest(http.MethodPost, "/account/oss-token", nil)
	mint.AddCookie(cookie)
	mrec := withAccount(acct, onb.MintOSS, mint)
	if mrec.Code != http.StatusPaymentRequired {
		t.Fatalf("mint without pay %d %s", mrec.Code, mrec.Body.String())
	}

	pay := httptest.NewRequest(http.MethodPost, "/account/verify-human", nil)
	pay.AddCookie(cookie)
	prec := withAccount(acct, onb.VerifyHuman, pay)
	if prec.Code != 200 {
		t.Fatalf("pay %d %s", prec.Code, prec.Body.String())
	}

	mint2 := httptest.NewRequest(http.MethodPost, "/account/oss-token", nil)
	mint2.AddCookie(cookie)
	mrec2 := withAccount(acct, onb.MintOSS, mint2)
	if mrec2.Code != 201 {
		t.Fatalf("mint %d %s", mrec2.Code, mrec2.Body.String())
	}
	var minted map[string]any
	_ = json.Unmarshal(mrec2.Body.Bytes(), &minted)
	code := minted["code"].(string)
	if len(code) != 6 {
		t.Fatalf("oss code %q", code)
	}

	bind := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bind.AddCookie(cookie)
	bind.RemoteAddr = "198.51.100.20:1"
	brec := httptest.NewRecorder()
	onb.Bind(brec, bind)
	if brec.Code != 200 {
		t.Fatalf("bind %d %s", brec.Code, brec.Body.String())
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/setup/ws", onb.SetupWS)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := helloWS(t, srv, code)
	defer c.Close()
	readType(t, c, "accepted")
	readType(t, c, "attached")
}

func TestGuessLimiter(t *testing.T) {
	onb, _, _ := testOnboarding(t)
	for i := 0; i < 9; i++ {
		req := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"FFFFF`+string(rune('0'+i))+`"}`))
		req.RemoteAddr = "192.0.2.55:1"
		rec := httptest.NewRecorder()
		onb.Bind(rec, req)
		if i < 8 && rec.Code == http.StatusTooManyRequests {
			t.Fatalf("limited too early at %d", i)
		}
		if i == 8 && rec.Code != http.StatusTooManyRequests {
			t.Fatalf("expected limiter, got %d %s", rec.Code, rec.Body.String())
		}
	}
}

func TestOfficialLocalCompleteNotAnonymousWebsiteBindWithoutSocket(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	token := mintOfficial(t, onb)
	cookie := registerAccount(t, acct, "local@b.co")
	bind := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+token+`"}`))
	bind.AddCookie(cookie)
	bind.RemoteAddr = "203.0.113.80:2"
	rec := httptest.NewRecorder()
	onb.Bind(rec, bind)
	nameReq := httptest.NewRequest(http.MethodPost, "/onboarding/name", bytes.NewBufferString(`{"subdomain":"stolen"}`))
	nameReq.AddCookie(cookie)
	nameReq.AddCookie(rec.Result().Cookies()[0])
	nrec := withAccount(acct, onb.Name, nameReq)
	if nrec.Code != http.StatusConflict {
		t.Fatalf("claim without live socket %d %s", nrec.Code, nrec.Body.String())
	}
}

func TestSettingsHelloCanRedeemOfficial(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	token := mintOfficial(t, onb)
	cookie := registerAccount(t, acct, "redeem@b.co")
	bind := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+token+`"}`))
	bind.AddCookie(cookie)
	bind.RemoteAddr = "203.0.113.81:2"
	brec := httptest.NewRecorder()
	onb.Bind(brec, bind)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/setup/ws", onb.SetupWS)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	u := "ws" + strings.TrimPrefix(srv.URL, "http") + "/api/v1/setup/ws"
	c, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.WriteJSON(map[string]any{"type": "hello", "token": token, "source": "settings", "local_port": 8090}); err != nil {
		t.Fatal(err)
	}
	readType(t, c, "accepted")
	readType(t, c, "attached")
	nameReq := httptest.NewRequest(http.MethodPost, "/onboarding/name", bytes.NewBufferString(`{"subdomain":"kitchen"}`))
	nameReq.AddCookie(cookie)
	nameReq.AddCookie(brec.Result().Cookies()[0])
	nrec := withAccount(acct, onb.Name, nameReq)
	if nrec.Code != 201 {
		t.Fatalf("redeem name %d %s", nrec.Code, nrec.Body.String())
	}
}

func TestBackupAfterOnboardingCard(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	token := mintOfficial(t, onb)
	cookie := registerAccount(t, acct, "bak@b.co")
	bind := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+token+`"}`))
	bind.AddCookie(cookie)
	bind.RemoteAddr = "198.51.100.9:3"
	brec := httptest.NewRecorder()
	onb.Bind(brec, bind)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/setup/ws", onb.SetupWS)
	srv := httptest.NewServer(mux)
	defer srv.Close()
	c := helloWS(t, srv, token)
	defer c.Close()
	readType(t, c, "accepted")
	readType(t, c, "attached")

	nameReq := httptest.NewRequest(http.MethodPost, "/onboarding/name", bytes.NewBufferString(`{"subdomain":"loft"}`))
	nameReq.AddCookie(cookie)
	nameReq.AddCookie(brec.Result().Cookies()[0])
	nrec := withAccount(acct, onb.Name, nameReq)
	if nrec.Code != 201 {
		t.Fatalf("name %d %s", nrec.Code, nrec.Body.String())
	}
	claimed := readType(t, c, "claimed")
	devToken := claimed["device_token"].(string)

	card := httptest.NewRequest(http.MethodPost, "/onboarding/backups", bytes.NewBufferString(`{"enable":true}`))
	card.AddCookie(cookie)
	crec := withAccount(acct, onb.Backups, card)
	if crec.Code != 200 {
		t.Fatalf("backups %d %s", crec.Code, crec.Body.String())
	}

	bak := BackupHandler{Deps: onb.Deps}
	put := httptest.NewRequest(http.MethodPut, "/backup/objects/hi.txt", bytes.NewBufferString("hello"))
	put.Header.Set("Authorization", "Bearer "+devToken)
	put.SetPathValue("*", "hi.txt")
	recP := httptest.NewRecorder()
	DeviceHandler{Deps: onb.Deps}.DeviceAuth(http.HandlerFunc(bak.PutObject)).ServeHTTP(recP, put)
	if recP.Code != 200 {
		t.Fatalf("put %d %s", recP.Code, recP.Body.String())
	}
}

func TestTokenHelpers(t *testing.T) {
	n := security.NormalizeToken("abcd-efgh-ijkl")
	if !strings.Contains(n, "1") { // I,L → 1
		t.Fatalf("crockford map %s", n)
	}
	if !security.IsOSSHex("A1B2C3") {
		t.Fatal("oss hex")
	}
}
