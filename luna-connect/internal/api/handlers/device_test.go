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
	id, code, err := insertPermanentDevice(d.DB, kind, security.OfficialBookletToken(), "")
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
}
