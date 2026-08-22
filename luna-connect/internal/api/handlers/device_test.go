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
	return Deps{
		DB: db, Store: st,
		Tunnel: &providers.TunnelClient{MockMode: true},
		DNS:    &providers.DNSClient{MockMode: true},
	}
}

func TestRegisterAndChangeDomain(t *testing.T) {
	d := testDeps(t)
	h := DeviceHandler{Deps: d}

	body := bytes.NewBufferString(`{"device_name":"Kitchen","subdomain":"photos","local_port":8090}`)
	req := httptest.NewRequest(http.MethodPost, "/register", body)
	req.RemoteAddr = "203.0.113.9:1234"
	rec := httptest.NewRecorder()
	h.Register(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("register %d %s", rec.Code, rec.Body.String())
	}
	var created map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	if created["hostname"] != "photos.luna.servers.libreloom.org" {
		t.Fatalf("hostname %v", created["hostname"])
	}
	token := created["device_token"].(string)

	req2 := httptest.NewRequest(http.MethodGet, "/status", nil)
	req2.Header.Set("Authorization", "Bearer "+token)
	rec2 := httptest.NewRecorder()
	h.DeviceAuth(http.HandlerFunc(h.Status)).ServeHTTP(rec2, req2)
	if rec2.Code != 200 {
		t.Fatalf("status %d %s", rec2.Code, rec2.Body.String())
	}

	req3 := httptest.NewRequest(http.MethodPost, "/domain", bytes.NewBufferString(`{"subdomain":"kitchen"}`))
	req3.Header.Set("Authorization", "Bearer "+token)
	rec3 := httptest.NewRecorder()
	h.DeviceAuth(http.HandlerFunc(h.Domain)).ServeHTTP(rec3, req3)
	if rec3.Code != 200 {
		t.Fatalf("domain %d %s", rec3.Code, rec3.Body.String())
	}
	var changed map[string]any
	_ = json.Unmarshal(rec3.Body.Bytes(), &changed)
	if changed["hostname"] != "kitchen.luna.servers.libreloom.org" {
		t.Fatalf("changed %v", changed)
	}
}

func TestBackupRequiresCard(t *testing.T) {
	d := testDeps(t)
	h := DeviceHandler{Deps: d}
	bak := BackupHandler{Deps: d}

	req := httptest.NewRequest(http.MethodPost, "/register", bytes.NewBufferString(`{"subdomain":"cabin"}`))
	req.RemoteAddr = "198.51.100.2:9"
	rec := httptest.NewRecorder()
	h.Register(rec, req)
	var created map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &created)
	token := created["device_token"].(string)

	put := httptest.NewRequest(http.MethodPut, "/backup/objects/notes.txt", bytes.NewBufferString("hi"))
	put.Header.Set("Authorization", "Bearer "+token)
	put.SetPathValue("*", "notes.txt")
	recP := httptest.NewRecorder()
	h.DeviceAuth(http.HandlerFunc(bak.PutObject)).ServeHTTP(recP, put)
	if recP.Code != http.StatusForbidden && recP.Code != http.StatusPaymentRequired {
		t.Fatalf("expected locked backup, got %d %s", recP.Code, recP.Body.String())
	}
}

func TestPairAndBackup(t *testing.T) {
	d := testDeps(t)
	devH := DeviceHandler{Deps: d}
	acctH := AccountHandler{Deps: d}
	bak := BackupHandler{Deps: d}

	reg := httptest.NewRequest(http.MethodPost, "/account/register", bytes.NewBufferString(`{"email":"a@b.co","password":"password1"}`))
	rec := httptest.NewRecorder()
	acctH.Register(rec, reg)
	if rec.Code != 201 {
		t.Fatalf("acct %d %s", rec.Code, rec.Body.String())
	}
	cookie := rec.Result().Cookies()[0]

	card := httptest.NewRequest(http.MethodPost, "/billing/attach-card", nil)
	card.AddCookie(cookie)
	recC := httptest.NewRecorder()
	acctH.AccountAuth(http.HandlerFunc(acctH.AttachCard)).ServeHTTP(recC, card)
	if recC.Code != 200 {
		t.Fatalf("card %d %s", recC.Code, recC.Body.String())
	}

	dreq := httptest.NewRequest(http.MethodPost, "/register", bytes.NewBufferString(`{"subdomain":"loft"}`))
	dreq.RemoteAddr = "192.0.2.8:1"
	drec := httptest.NewRecorder()
	devH.Register(drec, dreq)
	var created map[string]any
	_ = json.Unmarshal(drec.Body.Bytes(), &created)
	token := created["device_token"].(string)

	preq := httptest.NewRequest(http.MethodPost, "/pairing-code", nil)
	preq.Header.Set("Authorization", "Bearer "+token)
	prec := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(devH.PairingCode)).ServeHTTP(prec, preq)
	var pair map[string]any
	_ = json.Unmarshal(prec.Body.Bytes(), &pair)
	code := pair["pairing_code"].(string)

	link := httptest.NewRequest(http.MethodPost, "/account/pair", bytes.NewBufferString(`{"code":"`+code+`"}`))
	link.AddCookie(cookie)
	lrec := httptest.NewRecorder()
	acctH.AccountAuth(http.HandlerFunc(acctH.Pair)).ServeHTTP(lrec, link)
	if lrec.Code != 200 {
		t.Fatalf("pair %d %s", lrec.Code, lrec.Body.String())
	}

	put := httptest.NewRequest(http.MethodPut, "/backup/objects/hi.txt", bytes.NewBufferString("hello"))
	put.Header.Set("Authorization", "Bearer "+token)
	put.SetPathValue("*", "hi.txt")
	prec2 := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(bak.PutObject)).ServeHTTP(prec2, put)
	if prec2.Code != 200 {
		t.Fatalf("put %d %s", prec2.Code, prec2.Body.String())
	}

	list := httptest.NewRequest(http.MethodGet, "/backups", nil)
	list.AddCookie(cookie)
	lrec2 := httptest.NewRecorder()
	acctH.AccountAuth(http.HandlerFunc(bak.List)).ServeHTTP(lrec2, list)
	if lrec2.Code != 200 || !bytes.Contains(lrec2.Body.Bytes(), []byte("hi.txt")) {
		t.Fatalf("list %d %s", lrec2.Code, lrec2.Body.String())
	}
}
