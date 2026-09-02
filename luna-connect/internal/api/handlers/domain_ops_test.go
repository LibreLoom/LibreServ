package handlers

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

func TestSyncDeviceLocalPortUpdatesIngress(t *testing.T) {
	d := testDeps(t)
	config.C.Cloudflare.AccountID = "acct"
	config.C.Cloudflare.APIToken = "token"
	config.C.Cloudflare.ZoneID = "zone"

	devID, _ := mintDevice(t, d, "official")
	now := time.Now().Unix()
	_, _ = d.DB.Exec(
		`UPDATE devices SET account_id = 'acct_sync', subdomain = 'syncbox', tunnel_id = 'tnl_sync', local_port = 8090, last_seen_at = ? WHERE id = ?`,
		now, devID,
	)

	syncDeviceLocalPort(d, devID, 80)

	var port int
	if err := d.DB.QueryRow(`SELECT local_port FROM devices WHERE id = ?`, devID).Scan(&port); err != nil {
		t.Fatal(err)
	}
	if port != 80 {
		t.Fatalf("local_port = %d, want 80", port)
	}
}

func TestStatusSyncsLocalPortFromHeader(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "port@b.co")
	verifyEmailFor(t, acctH, "port@b.co")

	devID, code := mintDevice(t, d, "official")
	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	bindRec := withVerifiedAccount(acctH, devH.Bind, bindReq)
	if bindRec.Code != http.StatusOK {
		t.Fatalf("bind %d %s", bindRec.Code, bindRec.Body.String())
	}

	now := time.Now().Unix()
	_, _ = d.DB.Exec(
		`UPDATE devices SET subdomain = 'hdrbox', tunnel_id = 'tnl_hdr', local_port = 8090, last_seen_at = ? WHERE id = ?`,
		now, devID,
	)

	stReq := httptest.NewRequest(http.MethodGet, "/status", nil)
	stReq.Header.Set("Authorization", "Bearer "+code)
	stReq.Header.Set("X-Luna-Local-Port", "80")
	stRec := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(devH.Status)).ServeHTTP(stRec, stReq)
	if stRec.Code != http.StatusOK {
		t.Fatalf("status code %d: %s", stRec.Code, stRec.Body.String())
	}

	var port int
	if err := d.DB.QueryRow(`SELECT local_port FROM devices WHERE id = ?`, devID).Scan(&port); err != nil {
		t.Fatal(err)
	}
	if port != 80 {
		t.Fatalf("local_port = %d, want 80", port)
	}
}
