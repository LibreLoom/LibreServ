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

func withOptionalAccount(acct AccountHandler, h http.HandlerFunc, req *http.Request) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	acct.OptionalAccountAuth(h).ServeHTTP(rec, req)
	return rec
}

func registerHubSocket(t *testing.T, onb OnboardingHandler, token string, dead bool) {
	t.Helper()
	hash := security.HashToken(security.NormalizeToken(token))
	sock := setuphub.NewSocket(hash, "127.0.0.1", "anonymous", 8090)
	if err := onb.Hub.Register(sock); err != nil {
		t.Fatal(err)
	}
	if dead {
		sock.Close()
	}
}

func tokenStatus(t *testing.T, onb OnboardingHandler, token string) string {
	t.Helper()
	var status string
	err := onb.DB.QueryRow(`SELECT status FROM issued_tokens WHERE token_hash = ?`, security.HashToken(security.NormalizeToken(token))).Scan(&status)
	if err != nil {
		t.Fatal(err)
	}
	return status
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
	brec := withOptionalAccount(acct, onb.Bind, bind)
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

func TestNameRollbackOnPushFail(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	token := mintOfficial(t, onb)
	cookie := registerAccount(t, acct, "pushfail@b.co")
	bind := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+token+`"}`))
	bind.AddCookie(cookie)
	bind.RemoteAddr = "203.0.113.40:4"
	brec := httptest.NewRecorder()
	onb.Bind(brec, bind)
	if brec.Code != 200 {
		t.Fatalf("bind %d %s", brec.Code, brec.Body.String())
	}
	registerHubSocket(t, onb, token, true)

	nameReq := httptest.NewRequest(http.MethodPost, "/onboarding/name", bytes.NewBufferString(`{"subdomain":"retryme"}`))
	nameReq.AddCookie(cookie)
	nameReq.AddCookie(brec.Result().Cookies()[0])
	nrec := withAccount(acct, onb.Name, nameReq)
	if nrec.Code != http.StatusConflict {
		t.Fatalf("want retryable conflict, got %d %s", nrec.Code, nrec.Body.String())
	}
	var n int
	_ = onb.DB.QueryRow(`SELECT COUNT(*) FROM devices`).Scan(&n)
	if n != 0 {
		t.Fatalf("device row after failed push: %d", n)
	}
	if tokenStatus(t, onb, token) != "issued" {
		t.Fatalf("token should stay issued, got %s", tokenStatus(t, onb, token))
	}
	var sessStatus string
	_ = onb.DB.QueryRow(`SELECT status FROM setup_sessions WHERE id = ?`, brec.Result().Cookies()[0].Value).Scan(&sessStatus)
	if sessStatus == "claimed" {
		t.Fatal("session claimed after failed push")
	}
}

func TestNameRejectsClaimedToken(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	token := mintOfficial(t, onb)
	cookie := registerAccount(t, acct, "claimed@b.co")
	bind := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+token+`"}`))
	bind.AddCookie(cookie)
	bind.RemoteAddr = "203.0.113.41:4"
	brec := httptest.NewRecorder()
	onb.Bind(brec, bind)
	_, _ = onb.DB.Exec(`UPDATE issued_tokens SET status = 'claimed' WHERE token_hash = ?`, security.HashToken(security.NormalizeToken(token)))
	registerHubSocket(t, onb, token, false)

	nameReq := httptest.NewRequest(http.MethodPost, "/onboarding/name", bytes.NewBufferString(`{"subdomain":"takenonce"}`))
	nameReq.AddCookie(cookie)
	nameReq.AddCookie(brec.Result().Cookies()[0])
	nrec := withAccount(acct, onb.Name, nameReq)
	if nrec.Code != http.StatusConflict {
		t.Fatalf("claimed token %d %s", nrec.Code, nrec.Body.String())
	}
}

func TestNameRejectsReplacedSession(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	token := mintOfficial(t, onb)
	cookie := registerAccount(t, acct, "replaced@b.co")
	bind1 := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+token+`"}`))
	bind1.AddCookie(cookie)
	bind1.RemoteAddr = "203.0.113.42:4"
	first := httptest.NewRecorder()
	onb.Bind(first, bind1)
	oldCookie := first.Result().Cookies()[0]

	bind2 := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+token+`"}`))
	bind2.AddCookie(cookie)
	bind2.RemoteAddr = "203.0.113.42:5"
	second := httptest.NewRecorder()
	onb.Bind(second, bind2)
	if second.Code != 200 {
		t.Fatalf("rebind %d %s", second.Code, second.Body.String())
	}
	registerHubSocket(t, onb, token, false)

	nameReq := httptest.NewRequest(http.MethodPost, "/onboarding/name", bytes.NewBufferString(`{"subdomain":"oldpage"}`))
	nameReq.AddCookie(cookie)
	nameReq.AddCookie(oldCookie)
	nrec := withAccount(acct, onb.Name, nameReq)
	if nrec.Code != http.StatusNotFound {
		t.Fatalf("replaced session %d %s", nrec.Code, nrec.Body.String())
	}
}

func TestOSSBindAndNameRejectOtherAccounts(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	owner := registerAccount(t, acct, "owner@b.co")
	other := registerAccount(t, acct, "other@b.co")

	pay := httptest.NewRequest(http.MethodPost, "/account/verify-human", nil)
	pay.AddCookie(owner)
	if rec := withAccount(acct, onb.VerifyHuman, pay); rec.Code != 200 {
		t.Fatalf("pay %d %s", rec.Code, rec.Body.String())
	}
	mint := httptest.NewRequest(http.MethodPost, "/account/oss-token", nil)
	mint.AddCookie(owner)
	mrec := withAccount(acct, onb.MintOSS, mint)
	if mrec.Code != 201 {
		t.Fatalf("mint %d %s", mrec.Code, mrec.Body.String())
	}
	var minted map[string]any
	_ = json.Unmarshal(mrec.Body.Bytes(), &minted)
	code := minted["code"].(string)

	anon := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	anon.RemoteAddr = "198.51.100.30:1"
	arec := httptest.NewRecorder()
	onb.Bind(arec, anon)
	if arec.Code != http.StatusUnauthorized {
		t.Fatalf("anon oss bind %d %s", arec.Code, arec.Body.String())
	}

	stolen := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	stolen.AddCookie(other)
	stolen.RemoteAddr = "198.51.100.31:1"
	srec := withOptionalAccount(acct, onb.Bind, stolen)
	if srec.Code != http.StatusForbidden {
		t.Fatalf("other oss bind %d %s", srec.Code, srec.Body.String())
	}

	okBind := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	okBind.AddCookie(owner)
	okBind.RemoteAddr = "198.51.100.32:1"
	brec := withOptionalAccount(acct, onb.Bind, okBind)
	if brec.Code != 200 {
		t.Fatalf("owner bind %d %s", brec.Code, brec.Body.String())
	}
	registerHubSocket(t, onb, code, false)

	nameReq := httptest.NewRequest(http.MethodPost, "/onboarding/name", bytes.NewBufferString(`{"subdomain":"notyours"}`))
	nameReq.AddCookie(other)
	nameReq.AddCookie(brec.Result().Cookies()[0])
	nrec := withAccount(acct, onb.Name, nameReq)
	if nrec.Code != http.StatusForbidden {
		t.Fatalf("other oss name %d %s", nrec.Code, nrec.Body.String())
	}
}

func TestAttachAccountCannotSteal(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	token := mintOfficial(t, onb)
	owner := registerAccount(t, acct, "attacha@b.co")
	other := registerAccount(t, acct, "attachb@b.co")
	bind := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+token+`"}`))
	bind.AddCookie(owner)
	bind.RemoteAddr = "203.0.113.50:1"
	brec := withOptionalAccount(acct, onb.Bind, bind)
	if brec.Code != 200 {
		t.Fatalf("bind %d %s", brec.Code, brec.Body.String())
	}
	att := httptest.NewRequest(http.MethodPost, "/onboarding/attach-account", nil)
	att.AddCookie(other)
	att.AddCookie(brec.Result().Cookies()[0])
	arec := withAccount(acct, onb.AttachAccount, att)
	if arec.Code != http.StatusForbidden {
		t.Fatalf("steal attach %d %s", arec.Code, arec.Body.String())
	}
}

func TestVerifyHumanIdempotent(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	cookie := registerAccount(t, acct, "idemp@b.co")
	pay := httptest.NewRequest(http.MethodPost, "/account/verify-human", nil)
	pay.AddCookie(cookie)
	first := withAccount(acct, onb.VerifyHuman, pay)
	if first.Code != 200 {
		t.Fatalf("first pay %d %s", first.Code, first.Body.String())
	}
	var pi1 string
	_ = onb.DB.QueryRow(`SELECT payment_intent_id FROM oss_payments WHERE account_id = (SELECT id FROM accounts WHERE email = 'idemp@b.co')`).Scan(&pi1)

	prev := config.C.Stripe
	config.C.Stripe.Enabled = true
	config.C.Stripe.SecretKey = "sk_test_not_used"
	t.Cleanup(func() { config.C.Stripe = prev })

	pay2 := httptest.NewRequest(http.MethodPost, "/account/verify-human", nil)
	pay2.AddCookie(cookie)
	second := withAccount(acct, onb.VerifyHuman, pay2)
	if second.Code != 200 {
		t.Fatalf("second pay should skip charge, got %d %s", second.Code, second.Body.String())
	}
	var pi2 string
	_ = onb.DB.QueryRow(`SELECT payment_intent_id FROM oss_payments WHERE account_id = (SELECT id FROM accounts WHERE email = 'idemp@b.co')`).Scan(&pi2)
	if pi1 != pi2 {
		t.Fatalf("payment id changed %s -> %s", pi1, pi2)
	}
}

func TestStripeNotReadyFailsClosed(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	cookie := registerAccount(t, acct, "nocard@b.co")
	prev := config.C.Stripe
	config.C.Stripe.Enabled = true
	config.C.Stripe.SecretKey = ""
	t.Cleanup(func() { config.C.Stripe = prev })

	pay := httptest.NewRequest(http.MethodPost, "/account/verify-human", bytes.NewBufferString(`{"payment_method":"pm_test"}`))
	pay.AddCookie(cookie)
	prec := withAccount(acct, onb.VerifyHuman, pay)
	if prec.Code != http.StatusServiceUnavailable {
		t.Fatalf("verify fail-closed %d %s", prec.Code, prec.Body.String())
	}

	bak := httptest.NewRequest(http.MethodPost, "/onboarding/backups", bytes.NewBufferString(`{"enable":true}`))
	bak.AddCookie(cookie)
	brec := withAccount(acct, onb.Backups, bak)
	if brec.Code != http.StatusServiceUnavailable {
		t.Fatalf("backups fail-closed %d %s", brec.Code, brec.Body.String())
	}

	config.C.Stripe.SecretKey = "sk_test_fake"
	missing := httptest.NewRequest(http.MethodPost, "/account/verify-human", nil)
	missing.AddCookie(cookie)
	mrec := withAccount(acct, onb.VerifyHuman, missing)
	if mrec.Code != http.StatusBadRequest {
		t.Fatalf("missing payment_method %d %s", mrec.Code, mrec.Body.String())
	}
}
