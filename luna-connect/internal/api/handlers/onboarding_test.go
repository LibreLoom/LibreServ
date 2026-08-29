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
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
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
	req := httptest.NewRequest(http.MethodPost, "/account/register", bytes.NewBufferString(`{"email":"`+email+`","password":"password1234"}`))
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
	var named map[string]any
	_ = json.Unmarshal(nrec.Body.Bytes(), &named)
	if named["setup_secret"] != claimed["setup_secret"] || named["hostname"] != claimed["hostname"] {
		t.Fatalf("name body %v claimed %v", named, claimed)
	}

	listReq := httptest.NewRequest(http.MethodGet, "/account/devices", nil)
	listReq.AddCookie(cookie)
	listReq.AddCookie(rec.Result().Cookies()[0])
	listRec := httptest.NewRecorder()
	acct.AccountAuth(http.HandlerFunc(acct.Devices)).ServeHTTP(listRec, listReq)
	if listRec.Code != 200 {
		t.Fatalf("devices %d %s", listRec.Code, listRec.Body.String())
	}
	var listed map[string]any
	_ = json.Unmarshal(listRec.Body.Bytes(), &listed)
	devs, _ := listed["devices"].([]any)
	if len(devs) != 1 {
		t.Fatalf("devices %v", listed)
	}
	row, _ := devs[0].(map[string]any)
	if row["setup_secret"] != named["setup_secret"] {
		t.Fatalf("stored setup_secret %v want %v", row["setup_secret"], named["setup_secret"])
	}

	devTok, _ := claimed["device_token"].(string)
	clearReq := httptest.NewRequest(http.MethodPost, "/first-user", nil)
	clearReq.Header.Set("Authorization", "Bearer "+devTok)
	clearRec := httptest.NewRecorder()
	DeviceHandler{Deps: onb.Deps}.DeviceAuth(http.HandlerFunc(DeviceHandler{Deps: onb.Deps}.FirstUserUsed)).ServeHTTP(clearRec, clearReq)
	if clearRec.Code != 200 {
		t.Fatalf("first-user %d %s", clearRec.Code, clearRec.Body.String())
	}
	againReq := httptest.NewRequest(http.MethodGet, "/account/devices", nil)
	againReq.AddCookie(cookie)
	againReq.AddCookie(rec.Result().Cookies()[0])
	again := httptest.NewRecorder()
	acct.AccountAuth(http.HandlerFunc(acct.Devices)).ServeHTTP(again, againReq)
	var listed2 map[string]any
	_ = json.Unmarshal(again.Body.Bytes(), &listed2)
	devs2, _ := listed2["devices"].([]any)
	row2, _ := devs2[0].(map[string]any)
	if _, ok := row2["setup_secret"]; ok {
		t.Fatalf("setup_secret should be gone after first user: %v", row2)
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
	if len(security.NormalizeToken(code)) < 16 {
		t.Fatalf("oss code too short %q", code)
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

func TestRegisterLoginRateLimit(t *testing.T) {
	_, acct, _ := testOnboarding(t)
	for i := 0; i < 11; i++ {
		req := httptest.NewRequest(http.MethodPost, "/account/login", bytes.NewBufferString(`{"email":"nobody@b.co","password":"wrongpass"}`))
		req.RemoteAddr = "198.51.100.77:9"
		rec := httptest.NewRecorder()
		acct.Login(rec, req)
		if i < 10 && rec.Code == http.StatusTooManyRequests {
			t.Fatalf("limited too early at %d", i)
		}
		if i == 10 && rec.Code != http.StatusTooManyRequests {
			t.Fatalf("expected limiter, got %d %s", rec.Code, rec.Body.String())
		}
	}
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

type recordingCloud struct {
	creates    []string
	deletes    []string
	dnsUpserts []string
	dnsDeletes []string
}

func (c *recordingCloud) CreateTunnel(_, _, name string) (*providers.TunnelCredentials, error) {
	c.creates = append(c.creates, name)
	return &providers.TunnelCredentials{TunnelID: "tun-" + name, Token: "tok-" + name}, nil
}

func (c *recordingCloud) ConfigureIngress(_, _, _, _, _ string) error { return nil }

func (c *recordingCloud) DeleteTunnel(_, _, tunnelID string) error {
	c.deletes = append(c.deletes, tunnelID)
	return nil
}

func (c *recordingCloud) UpsertCNAME(_, _, hostname, _ string) error {
	c.dnsUpserts = append(c.dnsUpserts, hostname)
	return nil
}

func (c *recordingCloud) DeleteRecord(_, _, hostname string) error {
	c.dnsDeletes = append(c.dnsDeletes, hostname)
	return nil
}

func attachRecordingCloud(onb *OnboardingHandler) *recordingCloud {
	rec := &recordingCloud{}
	onb.Tunnel = rec
	onb.DNS = rec
	return rec
}

func (c *recordingCloud) assertRolledBack(t *testing.T, sub string) {
	t.Helper()
	wantTun := "luna-" + sub
	if len(c.creates) != 1 || c.creates[0] != wantTun {
		t.Fatalf("creates %v want [%s]", c.creates, wantTun)
	}
	wantID := "tun-" + wantTun
	if len(c.deletes) != 1 || c.deletes[0] != wantID {
		t.Fatalf("deletes %v want [%s]", c.deletes, wantID)
	}
	host := sub + "." + config.C.Server.PublicZone
	if len(c.dnsUpserts) != 1 || c.dnsUpserts[0] != host {
		t.Fatalf("dns upserts %v want [%s]", c.dnsUpserts, host)
	}
	if len(c.dnsDeletes) != 1 || c.dnsDeletes[0] != host {
		t.Fatalf("dns deletes %v want [%s]", c.dnsDeletes, host)
	}
}

func TestNameInsertOkPushFailKeepsDeviceThenRetry(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	cloud := attachRecordingCloud(&onb)
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
	if n != 1 {
		t.Fatalf("device row after failed push: %d", n)
	}
	if tokenStatus(t, onb, token) != "claimed" {
		t.Fatalf("token should stay claimed, got %s", tokenStatus(t, onb, token))
	}
	if len(cloud.creates) != 1 {
		t.Fatalf("creates %v", cloud.creates)
	}
	if len(cloud.deletes) != 0 {
		t.Fatalf("must not roll back Cloudflare after insert: deletes %v", cloud.deletes)
	}

	registerHubSocket(t, onb, token, false)
	retry := httptest.NewRequest(http.MethodPost, "/onboarding/name", bytes.NewBufferString(`{"subdomain":"retryme"}`))
	retry.AddCookie(cookie)
	retry.AddCookie(brec.Result().Cookies()[0])
	rrec := withAccount(acct, onb.Name, retry)
	if rrec.Code != http.StatusConflict {
		t.Fatalf("retry after claim must not re-send tokens, got %d %s", rrec.Code, rrec.Body.String())
	}
	if len(cloud.creates) != 1 {
		t.Fatalf("retry must not create a second tunnel: %v", cloud.creates)
	}
}

func TestNameRollbackOnInsertFail(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	rec := attachRecordingCloud(&onb)
	token := mintOfficial(t, onb)
	cookie := registerAccount(t, acct, "insfail@b.co")
	bind := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+token+`"}`))
	bind.AddCookie(cookie)
	bind.RemoteAddr = "203.0.113.43:4"
	brec := httptest.NewRecorder()
	onb.Bind(brec, bind)
	if brec.Code != 200 {
		t.Fatalf("bind %d %s", brec.Code, brec.Body.String())
	}
	registerHubSocket(t, onb, token, false)
	if _, err := onb.DB.Exec(`CREATE TRIGGER fail_devices BEFORE INSERT ON devices BEGIN SELECT RAISE(ABORT, 'boom'); END`); err != nil {
		t.Fatal(err)
	}

	nameReq := httptest.NewRequest(http.MethodPost, "/onboarding/name", bytes.NewBufferString(`{"subdomain":"orphanme"}`))
	nameReq.AddCookie(cookie)
	nameReq.AddCookie(brec.Result().Cookies()[0])
	nrec := withAccount(acct, onb.Name, nameReq)
	if nrec.Code != http.StatusConflict {
		t.Fatalf("want insert fail, got %d %s", nrec.Code, nrec.Body.String())
	}
	var n int
	_ = onb.DB.QueryRow(`SELECT COUNT(*) FROM devices`).Scan(&n)
	if n != 0 {
		t.Fatalf("device row after failed insert: %d", n)
	}
	if tokenStatus(t, onb, token) != "issued" {
		t.Fatalf("token should stay issued, got %s", tokenStatus(t, onb, token))
	}
	rec.assertRolledBack(t, "orphanme")
	hash := security.HashToken(security.NormalizeToken(token))
	sock := onb.Hub.Live(hash)
	if sock == nil || sock.Dead() {
		t.Fatal("insert fail must not push claimed or drop the live socket")
	}
	select {
	case msg := <-sock.Recv():
		t.Fatalf("claimed must not be pushed before insert: %v", msg)
	default:
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

	card := httptest.NewRequest(http.MethodPost, "/billing/attach-card", nil)
	card.AddCookie(cookie)
	crec := withAccount(acct, acct.AttachCard, card)
	if crec.Code != http.StatusServiceUnavailable {
		t.Fatalf("attach-card fail-closed %d %s", crec.Code, crec.Body.String())
	}
	var has int
	var status string
	_ = onb.DB.QueryRow(`SELECT has_card, billing_status FROM accounts WHERE email = 'nocard@b.co'`).Scan(&has, &status)
	if has != 0 || status != "none" {
		t.Fatalf("attach-card must not mark billed, has=%d status=%s", has, status)
	}

	config.C.Stripe.SecretKey = "sk_test_fake"
	missing := httptest.NewRequest(http.MethodPost, "/account/verify-human", nil)
	missing.AddCookie(cookie)
	mrec := withAccount(acct, onb.VerifyHuman, missing)
	if mrec.Code != http.StatusBadRequest {
		t.Fatalf("missing payment_method %d %s", mrec.Code, mrec.Body.String())
	}
}

func TestAttachCardDevBypass(t *testing.T) {
	t.Setenv("LUNACONNECT_DEV", "1")
	_, acct, _ := testOnboarding(t)
	cookie := registerAccount(t, acct, "devcard@b.co")
	prev := config.C.Stripe
	config.C.Stripe.Enabled = false
	config.C.Stripe.SecretKey = ""
	t.Cleanup(func() { config.C.Stripe = prev })

	card := httptest.NewRequest(http.MethodPost, "/billing/attach-card", nil)
	card.AddCookie(cookie)
	crec := withAccount(acct, acct.AttachCard, card)
	if crec.Code != 200 {
		t.Fatalf("dev attach-card %d %s", crec.Code, crec.Body.String())
	}
	var has int
	var status, item string
	_ = acct.DB.QueryRow(`SELECT has_card, billing_status, COALESCE(stripe_subscription_item_id,'') FROM accounts WHERE email = 'devcard@b.co'`).Scan(&has, &status, &item)
	if has != 1 || status != "dev" || item != "si_dev" {
		t.Fatalf("dev attach-card has=%d status=%s item=%s", has, status, item)
	}
}

func TestAttachCardWithoutDevFailsClosed(t *testing.T) {
	_, acct, _ := testOnboarding(t)
	cookie := registerAccount(t, acct, "prodcard@b.co")
	t.Setenv("LUNACONNECT_DEV", "")
	prev := config.C.Stripe
	config.C.Stripe.Enabled = false
	config.C.Stripe.SecretKey = ""
	t.Cleanup(func() { config.C.Stripe = prev })

	card := httptest.NewRequest(http.MethodPost, "/billing/attach-card", bytes.NewBufferString(`{}`))
	card.AddCookie(cookie)
	crec := withAccount(acct, acct.AttachCard, card)
	if crec.Code != http.StatusServiceUnavailable {
		t.Fatalf("prod attach-card without stripe %d %s", crec.Code, crec.Body.String())
	}
	var has int
	var status string
	_ = acct.DB.QueryRow(`SELECT has_card, billing_status FROM accounts WHERE email = 'prodcard@b.co'`).Scan(&has, &status)
	if has != 0 || status != "none" {
		t.Fatalf("must not unlock, has=%d status=%s", has, status)
	}
}

// Any stored subscription id means one already exists at Stripe: a past_due
// account must NOT trigger a second subscription that keeps billing after we
// overwrite the stored id and lose track of it. A fake-but-live Stripe config
// arms the real billing path, so a stacked Subscribe would actually be
// attempted (and fail against the fake key) instead of being silently
// skipped.
func TestAttachCardDoesNotStackSubscriptions(t *testing.T) {
	_, acct, _ := testOnboarding(t)
	cookie := registerAccount(t, acct, "stacked@b.co")
	prev := config.C.Stripe
	config.C.Stripe.Enabled = true
	config.C.Stripe.SecretKey = "sk_test_gate"
	config.C.Stripe.PriceID = "price_test"
	t.Cleanup(func() { config.C.Stripe = prev })
	var id string
	_ = acct.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'stacked@b.co'`).Scan(&id)
	_, _ = acct.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'past_due', stripe_subscription_id = 'sub_existing', stripe_subscription_item_id = 'si_existing' WHERE id = ?`, id)

	card := httptest.NewRequest(http.MethodPost, "/billing/attach-card", bytes.NewBufferString(`{}`))
	card.AddCookie(cookie)
	crec := withAccount(acct, acct.AttachCard, card)
	if crec.Code != http.StatusOK {
		t.Fatalf("attach-card %d %s", crec.Code, crec.Body.String())
	}
	var out map[string]any
	if err := json.Unmarshal(crec.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if out["already_active"] != false {
		t.Fatalf("past_due account reported already_active=%v", out["already_active"])
	}
	var subID, itemID string
	_ = acct.DB.QueryRow(`SELECT stripe_subscription_id, COALESCE(stripe_subscription_item_id,'') FROM accounts WHERE id = ?`, id).Scan(&subID, &itemID)
	if subID != "sub_existing" || itemID != "si_existing" {
		t.Fatalf("stored subscription changed: sub=%q item=%q", subID, itemID)
	}
}
