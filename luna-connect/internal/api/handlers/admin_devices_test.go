package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func TestAdminGetAccountIncludesTunnelFields(t *testing.T) {
	d := testDeps(t)
	h := AdminConsoleHandler{Deps: d}
	now := time.Now().Unix()
	_, _ = d.DB.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES ('acct_tunnel', 'tunnel@b.co', 'x', 1, 'active', 1, ?)`, now)

	id, _, err := insertPermanentDevice(d.DB, "official", security.OfficialDeviceToken(), "order-tunnel")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = d.DB.Exec(`UPDATE devices SET account_id = 'acct_tunnel', subdomain = 'mybox', tunnel_id = 'tnl_old', last_seen_at = ? WHERE id = ?`, now, id)

	req := httptest.NewRequest(http.MethodGet, "/admin/accounts/acct_tunnel", nil)
	req = withChiParam(req, "accountID", "acct_tunnel")
	rec := httptest.NewRecorder()
	h.GetAccount(rec, req)
	if rec.Code != 200 {
		t.Fatalf("get account %d %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	devices := body["devices"].([]any)
	if len(devices) != 1 {
		t.Fatalf("devices: %v", devices)
	}
	dev := devices[0].(map[string]any)
	if dev["tunnel_id"] != "tnl_old" {
		t.Fatalf("tunnel_id: %v", dev["tunnel_id"])
	}
	if dev["has_tunnel"] != true {
		t.Fatalf("has_tunnel: %v", dev["has_tunnel"])
	}
	if dev["device_hostname"] != "mybox.luna.servers.libreloom.org" {
		t.Fatalf("hostname: %v", dev["device_hostname"])
	}
}

func TestAdminRegenerateTunnel(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	consoleH := AdminConsoleHandler{Deps: d}

	cookie := registerAccount(t, acctH, "regen@b.co")
	verifyEmailFor(t, acctH, "regen@b.co")
	devID, code := mintDevice(t, d, "official")

	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	bindRec := withVerifiedAccount(acctH, devH.Bind, bindReq)
	if bindRec.Code != http.StatusOK {
		t.Fatalf("bind %d %s", bindRec.Code, bindRec.Body.String())
	}

	domReq := httptest.NewRequest(http.MethodPost, "/devices/"+devID+"/domain", bytes.NewBufferString(`{"subdomain":"regenbox"}`))
	domReq.AddCookie(cookie)
	domReq = withChiParam(domReq, "deviceID", devID)
	domRec := withVerifiedAccount(acctH, devH.SetDomain, domReq)
	if domRec.Code != http.StatusCreated && domRec.Code != http.StatusOK {
		t.Fatalf("domain %d %s", domRec.Code, domRec.Body.String())
	}

	var oldTunnel string
	_ = d.DB.QueryRow(`SELECT COALESCE(tunnel_id,'') FROM devices WHERE id = ?`, devID).Scan(&oldTunnel)
	if oldTunnel == "" {
		t.Fatal("expected tunnel before regenerate")
	}

	regenReq := httptest.NewRequest(http.MethodPost, "/admin/devices/"+devID+"/regenerate-tunnel", nil)
	regenReq = withChiParam(regenReq, "deviceID", devID)
	regenRec := httptest.NewRecorder()
	consoleH.RegenerateDeviceTunnel(regenRec, regenReq)
	if regenRec.Code != http.StatusOK {
		t.Fatalf("regenerate %d %s", regenRec.Code, regenRec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(regenRec.Body.Bytes(), &out)
	if out["hostname"] != "regenbox.luna.servers.libreloom.org" {
		t.Fatalf("hostname: %v", out["hostname"])
	}
	if out["regenerated"] != true {
		t.Fatalf("regenerated: %v", out["regenerated"])
	}

	var newTunnel, sealed string
	_ = d.DB.QueryRow(`SELECT COALESCE(tunnel_id,''), COALESCE(tunnel_token,'') FROM devices WHERE id = ?`, devID).Scan(&newTunnel, &sealed)
	if newTunnel == "" {
		t.Fatal("tunnel_id should remain set after regenerate")
	}
	if sealed == "" {
		t.Fatal("tunnel_token should remain set after regenerate")
	}
	var sub string
	_ = d.DB.QueryRow(`SELECT COALESCE(subdomain,'') FROM devices WHERE id = ?`, devID).Scan(&sub)
	if sub != "regenbox" {
		t.Fatalf("subdomain should stay regenbox, got %q", sub)
	}
}

func TestAdminSetDeviceDomain(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	consoleH := AdminConsoleHandler{Deps: d}

	cookie := registerAccount(t, acctH, "admindom@b.co")
	verifyEmailFor(t, acctH, "admindom@b.co")
	devID, code := mintDevice(t, d, "official")

	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	withVerifiedAccount(acctH, devH.Bind, bindReq)

	first := httptest.NewRequest(http.MethodPost, "/admin/devices/"+devID+"/domain", bytes.NewBufferString(`{"subdomain":"firstbox"}`))
	first = withChiParam(first, "deviceID", devID)
	firstRec := httptest.NewRecorder()
	consoleH.SetDeviceDomain(firstRec, first)
	if firstRec.Code != http.StatusCreated {
		t.Fatalf("first domain %d %s", firstRec.Code, firstRec.Body.String())
	}

	second := httptest.NewRequest(http.MethodPost, "/admin/devices/"+devID+"/domain", bytes.NewBufferString(`{"subdomain":"secondbox"}`))
	second = withChiParam(second, "deviceID", devID)
	secondRec := httptest.NewRecorder()
	consoleH.SetDeviceDomain(secondRec, second)
	if secondRec.Code != http.StatusCreated {
		t.Fatalf("rename domain %d %s", secondRec.Code, secondRec.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(secondRec.Body.Bytes(), &body)
	if body["hostname"] != "secondbox.luna.servers.libreloom.org" {
		t.Fatalf("hostname: %v", body["hostname"])
	}
	var sub string
	_ = d.DB.QueryRow(`SELECT COALESCE(subdomain,'') FROM devices WHERE id = ?`, devID).Scan(&sub)
	if sub != "secondbox" {
		t.Fatalf("subdomain: %q", sub)
	}
}

func TestAdminGetDeviceDetail(t *testing.T) {
	d := testDeps(t)
	h := AdminConsoleHandler{Deps: d}
	now := time.Now().Unix()
	_, _ = d.DB.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES ('acct_view', 'view@b.co', 'x', 0, 'none', 1, ?)`, now)

	id, _, err := insertPermanentDevice(d.DB, "official", security.OfficialDeviceToken(), "")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = d.DB.Exec(`UPDATE devices SET account_id = 'acct_view', subdomain = 'viewbox', tunnel_id = 'tnl_view', last_seen_at = ? WHERE id = ?`, now, id)

	req := httptest.NewRequest(http.MethodGet, "/admin/devices/"+id, nil)
	req = withChiParam(req, "deviceID", id)
	rec := httptest.NewRecorder()
	h.GetDevice(rec, req)
	if rec.Code != 200 {
		t.Fatalf("get device %d %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["account_email"] != "view@b.co" {
		t.Fatalf("account_email: %v", body["account_email"])
	}
	if body["tunnel_id"] != "tnl_view" {
		t.Fatalf("tunnel_id: %v", body["tunnel_id"])
	}
	if body["online"] != true {
		t.Fatalf("online: %v", body["online"])
	}
	code, _ := body["code"].(string)
	if code == "" || !strings.Contains(code, "-") {
		t.Fatalf("expected sealed device code in admin detail, got %v", body["code"])
	}
	hint, _ := body["hint"].(string)
	if hint == "" {
		t.Fatalf("expected hint, got %v", body["hint"])
	}
}

func TestAdminRegenerateTunnelRequiresSubdomain(t *testing.T) {
	d := testDeps(t)
	h := AdminConsoleHandler{Deps: d}
	now := time.Now().Unix()
	_, _ = d.DB.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES ('acct_nosub', 'nosub@b.co', 'x', 0, 'none', 1, ?)`, now)

	id, _, err := insertPermanentDevice(d.DB, "official", security.OfficialDeviceToken(), "")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = d.DB.Exec(`UPDATE devices SET account_id = 'acct_nosub' WHERE id = ?`, id)

	req := httptest.NewRequest(http.MethodPost, "/admin/devices/"+id+"/regenerate-tunnel", nil)
	req = withChiParam(req, "deviceID", id)
	rec := httptest.NewRecorder()
	h.RegenerateDeviceTunnel(rec, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d %s", rec.Code, rec.Body.String())
	}
}
