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
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/setuphub"
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
	t.Setenv("LUNACONNECT_DEV", "1")
	return Deps{
		DB: db, Store: st,
		Tunnel: &providers.TunnelClient{MockMode: true},
		DNS:    &providers.DNSClient{MockMode: true},
		Hub:    setuphub.New(),
	}
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
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["message"] == nil {
		t.Fatal("expected message")
	}
}
