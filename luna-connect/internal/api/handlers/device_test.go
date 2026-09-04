package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

func testDeps(t *testing.T) Deps {
	t.Helper()
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	st, err := store.NewLocal(filepath.Join(dir, "obj"))
	if err != nil {
		t.Fatal(err)
	}
	config.C.Server.PublicZone = "luna.servers.libreloom.org"
	config.C.Server.BaseURL = "https://connect.luna.libreloom.org"
	config.C.Server.AtRestKey = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
	t.Setenv("LUNACONNECT_DEV", "1")
	return Deps{
		DB: db, Store: st,
		Tunnel: &providers.TunnelClient{MockMode: true},
		DNS:    &providers.DNSClient{MockMode: true},
	}
}

func mintDevice(t *testing.T, d Deps, kind string) (id, code string) {
	t.Helper()
	id, code, err := insertPermanentDevice(d.DB, kind, security.OfficialDeviceToken(), "")
	if err != nil {
		t.Fatal(err)
	}
	return id, code
}

func TestRegisterGoneOnHandler(t *testing.T) {
	d := testDeps(t)
	h := DeviceHandler{Deps: d}
	req := httptest.NewRequest(http.MethodPost, "/register", bytes.NewBufferString(`{"subdomain":"photos"}`))
	rec := httptest.NewRecorder()
	h.Register(rec, req)
	if rec.Code != http.StatusGone {
		t.Fatalf("got %d %s", rec.Code, rec.Body.String())
	}
}

func TestOfflineBindStatusUnbind(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "owner@b.co")
	verifyEmailFor(t, acctH, "owner@b.co")

	devID, code := mintDevice(t, d, "official")

	stReq := httptest.NewRequest(http.MethodGet, "/status", nil)
	stReq.Header.Set("Authorization", "Bearer "+code)
	stRec := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(devH.Status)).ServeHTTP(stRec, stReq)
	if stRec.Code != http.StatusForbidden {
		t.Fatalf("unbound status %d %s", stRec.Code, stRec.Body.String())
	}

	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	bindRec := withVerifiedAccount(acctH, devH.Bind, bindReq)
	if bindRec.Code != http.StatusOK {
		t.Fatalf("bind %d %s", bindRec.Code, bindRec.Body.String())
	}

	stReq2 := httptest.NewRequest(http.MethodGet, "/status", nil)
	stReq2.Header.Set("Authorization", "Bearer "+code)
	stRec2 := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(devH.Status)).ServeHTTP(stRec2, stReq2)
	if stRec2.Code != http.StatusOK {
		t.Fatalf("bound status %d %s", stRec2.Code, stRec2.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(stRec2.Body.Bytes(), &body)
	if body["bound"] != true {
		t.Fatalf("expected bound: %v", body)
	}

	domReq := httptest.NewRequest(http.MethodPost, "/devices/"+devID+"/domain", bytes.NewBufferString(`{"subdomain":"photos"}`))
	domReq.AddCookie(cookie)
	domReq = withChiParam(domReq, "deviceID", devID)
	domRec := withVerifiedAccount(acctH, devH.SetDomain, domReq)
	if domRec.Code != http.StatusCreated && domRec.Code != http.StatusOK {
		t.Fatalf("domain %d %s", domRec.Code, domRec.Body.String())
	}

	unReq := httptest.NewRequest(http.MethodDelete, "/devices/"+devID, nil)
	unReq.AddCookie(cookie)
	unReq = withChiParam(unReq, "deviceID", devID)
	unRec := withVerifiedAccount(acctH, devH.Unbind, unReq)
	if unRec.Code != http.StatusOK {
		t.Fatalf("unbind %d %s", unRec.Code, unRec.Body.String())
	}

	stReq3 := httptest.NewRequest(http.MethodGet, "/status", nil)
	stReq3.Header.Set("Authorization", "Bearer "+code)
	stRec3 := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(devH.Status)).ServeHTTP(stRec3, stReq3)
	if stRec3.Code != http.StatusForbidden {
		t.Fatalf("after unbind status %d", stRec3.Code)
	}

	var n int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM devices WHERE id = ? AND account_id IS NULL`, devID).Scan(&n)
	if n != 1 {
		t.Fatal("permanent device row must survive unbind")
	}
}

func TestSetDomainFailsWithoutAtRestKey(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "seal@b.co")
	verifyEmailFor(t, acctH, "seal@b.co")

	devID, code := mintDevice(t, d, "official")
	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	bindRec := withVerifiedAccount(acctH, devH.Bind, bindReq)
	if bindRec.Code != http.StatusOK {
		t.Fatalf("bind %d %s", bindRec.Code, bindRec.Body.String())
	}

	config.C.Server.AtRestKey = ""
	t.Setenv("LUNACONNECT_DEV", "")

	domReq := httptest.NewRequest(http.MethodPost, "/devices/"+devID+"/domain", bytes.NewBufferString(`{"subdomain":"photos"}`))
	domReq.AddCookie(cookie)
	domReq = withChiParam(domReq, "deviceID", devID)
	domRec := withVerifiedAccount(acctH, devH.SetDomain, domReq)
	if domRec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d %s", domRec.Code, domRec.Body.String())
	}
	var sub string
	_ = d.DB.QueryRow(`SELECT COALESCE(subdomain,'') FROM devices WHERE id = ?`, devID).Scan(&sub)
	if sub != "" {
		t.Fatalf("subdomain should stay empty when at-rest key is missing, got %q", sub)
	}
}

func TestSetDomainFailsWithoutCloudflareInProduction(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "cf@b.co")
	verifyEmailFor(t, acctH, "cf@b.co")

	devID, code := mintDevice(t, d, "official")
	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	bindRec := withVerifiedAccount(acctH, devH.Bind, bindReq)
	if bindRec.Code != http.StatusOK {
		t.Fatalf("bind %d %s", bindRec.Code, bindRec.Body.String())
	}

	prev := config.C.Cloudflare
	t.Cleanup(func() { config.C.Cloudflare = prev })
	config.C.Cloudflare = config.CloudflareConfig{}
	t.Setenv("LUNACONNECT_DEV", "")

	domReq := httptest.NewRequest(http.MethodPost, "/devices/"+devID+"/domain", bytes.NewBufferString(`{"subdomain":"photos"}`))
	domReq.AddCookie(cookie)
	domReq = withChiParam(domReq, "deviceID", devID)
	domRec := withVerifiedAccount(acctH, devH.SetDomain, domReq)
	if domRec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d %s", domRec.Code, domRec.Body.String())
	}
}

func TestSetDomainWithDBCloudflareCreds(t *testing.T) {
	d := testDeps(t)
	prev := config.C.Cloudflare
	t.Cleanup(func() {
		config.C.Cloudflare = prev
		providers.CaptureCloudflareBase()
		providers.SetCloudflareRuntimeDB(nil)
		t.Setenv("LUNACONNECT_DEV", "1")
	})
	config.C.Cloudflare = config.CloudflareConfig{}
	providers.CaptureCloudflareBase()
	providers.SetCloudflareRuntimeDB(d.DB)

	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "dbcf@b.co")
	verifyEmailFor(t, acctH, "dbcf@b.co")

	devID, code := mintDevice(t, d, "official")
	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	bindRec := withVerifiedAccount(acctH, devH.Bind, bindReq)
	if bindRec.Code != http.StatusOK {
		t.Fatalf("bind %d %s", bindRec.Code, bindRec.Body.String())
	}

	svc := providers.NewService(d.DB)
	_, err := svc.Create("cloudflare", "Cloudflare", map[string]string{
		"account_id": "cf-account",
		"api_token":  "cf-token",
	}, map[string]string{
		"zone_id": "cf-zone",
	}, true)
	if err != nil {
		t.Fatal(err)
	}
	providers.RefreshCloudflare()
	if !config.C.Cloudflare.Ready() {
		t.Fatal("expected cloudflare ready from DB")
	}

	t.Setenv("LUNACONNECT_DEV", "")

	domReq := httptest.NewRequest(http.MethodPost, "/devices/"+devID+"/domain", bytes.NewBufferString(`{"subdomain":"pantry"}`))
	domReq.AddCookie(cookie)
	domReq = withChiParam(domReq, "deviceID", devID)
	domRec := withVerifiedAccount(acctH, devH.SetDomain, domReq)
	if domRec.Code != http.StatusCreated && domRec.Code != http.StatusOK {
		t.Fatalf("domain %d %s", domRec.Code, domRec.Body.String())
	}
}

func TestSetDomainSkipsWhenSubdomainAlreadySet(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "named@b.co")
	verifyEmailFor(t, acctH, "named@b.co")

	devID, code := mintDevice(t, d, "official")
	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	withVerifiedAccount(acctH, devH.Bind, bindReq)

	first := httptest.NewRequest(http.MethodPost, "/devices/"+devID+"/domain", bytes.NewBufferString(`{"subdomain":"photos"}`))
	first.AddCookie(cookie)
	first = withChiParam(first, "deviceID", devID)
	firstRec := withVerifiedAccount(acctH, devH.SetDomain, first)
	if firstRec.Code != http.StatusCreated && firstRec.Code != http.StatusOK {
		t.Fatalf("first domain %d %s", firstRec.Code, firstRec.Body.String())
	}

	second := httptest.NewRequest(http.MethodPost, "/devices/"+devID+"/domain", bytes.NewBufferString(`{"subdomain":"photos"}`))
	second.AddCookie(cookie)
	second = withChiParam(second, "deviceID", devID)
	secondRec := withVerifiedAccount(acctH, devH.SetDomain, second)
	if secondRec.Code != http.StatusOK {
		t.Fatalf("repeat domain %d %s", secondRec.Code, secondRec.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(secondRec.Body.Bytes(), &body)
	if body["hostname"] != "photos.luna.servers.libreloom.org" {
		t.Fatalf("hostname: %v", body["hostname"])
	}
	tok, _ := body["tunnel_token"].(string)
	if tok == "" {
		t.Fatal("same-subdomain SetDomain must return tunnel_token when sealed token opens")
	}
}

func TestDeviceDomainSameSubdomainReturnsTunnelToken(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "domain-same@b.co")
	verifyEmailFor(t, acctH, "domain-same@b.co")

	_, code := mintDevice(t, d, "official")
	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	if rec := withVerifiedAccount(acctH, devH.Bind, bindReq); rec.Code != http.StatusOK {
		t.Fatalf("bind %d %s", rec.Code, rec.Body.String())
	}

	// Device Domain first call: provisions (or no-ops if already set via SetDomain).
	// Use account SetDomain to create tunnel credentials first.
	devID := ""
	_ = d.DB.QueryRow(`SELECT id FROM devices WHERE account_id IS NOT NULL LIMIT 1`).Scan(&devID)
	setReq := httptest.NewRequest(http.MethodPost, "/devices/"+devID+"/domain", bytes.NewBufferString(`{"subdomain":"yaya"}`))
	setReq.AddCookie(cookie)
	setReq = withChiParam(setReq, "deviceID", devID)
	setRec := withVerifiedAccount(acctH, devH.SetDomain, setReq)
	if setRec.Code != http.StatusCreated && setRec.Code != http.StatusOK {
		t.Fatalf("set domain %d %s", setRec.Code, setRec.Body.String())
	}
	var first map[string]any
	_ = json.Unmarshal(setRec.Body.Bytes(), &first)
	wantTok, _ := first["tunnel_token"].(string)
	if wantTok == "" {
		t.Fatal("expected tunnel_token from SetDomain")
	}

	// Device.Domain same-subdomain early return must include tunnel_token.
	domReq := httptest.NewRequest(http.MethodPost, "/api/v1/domain", bytes.NewBufferString(`{"subdomain":"yaya"}`))
	domReq.Header.Set("Authorization", "Bearer "+code)
	domRec := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(devH.Domain)).ServeHTTP(domRec, domReq)
	if domRec.Code != http.StatusOK {
		t.Fatalf("device domain same-sub %d %s", domRec.Code, domRec.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(domRec.Body.Bytes(), &body)
	if body["hostname"] != "yaya.luna.servers.libreloom.org" {
		t.Fatalf("hostname: %v", body["hostname"])
	}
	gotTok, _ := body["tunnel_token"].(string)
	if gotTok == "" {
		t.Fatal("Device.Domain same-subdomain early return omitted tunnel_token")
	}
	if gotTok != wantTok {
		t.Fatalf("tunnel_token mismatch: got %q want %q", gotTok, wantTok)
	}
}
