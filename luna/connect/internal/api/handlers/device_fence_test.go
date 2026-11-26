package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

type fenceTunnel struct {
	providers.Tunnel
	mu      sync.Mutex
	created []string
	deleted []string
	started chan struct{}
	release chan struct{}
}

func (t *fenceTunnel) CreateTunnel(accountID, apiToken, name string) (*providers.TunnelCredentials, error) {
	if t.started != nil {
		close(t.started)
		<-t.release
	}
	creds, err := t.Tunnel.CreateTunnel(accountID, apiToken, name)
	if err == nil {
		t.mu.Lock()
		t.created = append(t.created, creds.TunnelID)
		t.mu.Unlock()
	}
	return creds, err
}

func (t *fenceTunnel) DeleteTunnel(accountID, apiToken, tunnelID string) error {
	t.mu.Lock()
	t.deleted = append(t.deleted, tunnelID)
	t.mu.Unlock()
	return t.Tunnel.DeleteTunnel(accountID, apiToken, tunnelID)
}

func (t *fenceTunnel) createdIDs() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]string(nil), t.created...)
}

func (t *fenceTunnel) deletedIDs() []string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return append([]string(nil), t.deleted...)
}

type fenceDNS struct {
	providers.DNS
	mu      sync.Mutex
	upserts []string
	deletes []string
}

func (d *fenceDNS) UpsertCNAME(apiToken, zoneID, hostname, target string) error {
	d.mu.Lock()
	d.upserts = append(d.upserts, hostname)
	d.mu.Unlock()
	return d.DNS.UpsertCNAME(apiToken, zoneID, hostname, target)
}

func (d *fenceDNS) DeleteRecord(apiToken, zoneID, hostname string) error {
	d.mu.Lock()
	d.deletes = append(d.deletes, hostname)
	d.mu.Unlock()
	return d.DNS.DeleteRecord(apiToken, zoneID, hostname)
}

func (d *fenceDNS) deletedHosts() []string {
	d.mu.Lock()
	defer d.mu.Unlock()
	return append([]string(nil), d.deletes...)
}

func stringContains(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func TestDomainFinalFenceFailureCleansProviderResources(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "domain-fence@b.co")
	verifyEmailFor(t, acctH, "domain-fence@b.co")
	_, uid := mintDevice(t, d, "official")
	devID, _ := pairDeviceForAccount(t, acctH, devH, cookie, uid)
	if rec := setAddress(t, acctH, devH, cookie, devID, "oldbox"); rec.Code != http.StatusCreated {
		t.Fatalf("initial address %d %s", rec.Code, rec.Body.String())
	}
	var oldTunnel string
	if err := d.DB.QueryRow(`SELECT tunnel_id FROM devices WHERE id = ?`, devID).Scan(&oldTunnel); err != nil {
		t.Fatal(err)
	}

	tunnel := &fenceTunnel{Tunnel: d.Tunnel}
	dns := &fenceDNS{DNS: d.DNS}
	d.Tunnel, d.DNS = tunnel, dns
	// DeviceHandler copied Deps before the swap; point it at the wrappers.
	devH.Deps = d
	if _, err := d.DB.Exec(`CREATE TRIGGER ignore_device_domain_update BEFORE UPDATE OF subdomain ON devices
BEGIN SELECT RAISE(IGNORE); END`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _, _ = d.DB.Exec(`DROP TRIGGER IF EXISTS ignore_device_domain_update`) })

	rec := setAddress(t, acctH, devH, cookie, devID, "newbox")
	if rec.Code != http.StatusConflict {
		t.Fatalf("fenced update status=%d body=%s", rec.Code, rec.Body.String())
	}
	var subdomain, storedTunnel string
	if err := d.DB.QueryRow(`SELECT subdomain, tunnel_id FROM devices WHERE id = ?`, devID).Scan(&subdomain, &storedTunnel); err != nil {
		t.Fatal(err)
	}
	if subdomain != "oldbox" || storedTunnel != oldTunnel {
		t.Fatalf("fenced update changed database: subdomain=%q tunnel=%q", subdomain, storedTunnel)
	}
	created := tunnel.createdIDs()
	if len(created) != 1 || stringContains(tunnel.deletedIDs(), oldTunnel) || !stringContains(tunnel.deletedIDs(), created[0]) {
		t.Fatalf("tunnel cleanup created=%v deleted=%v", created, tunnel.deletedIDs())
	}
	newHost := "newbox." + config.C.Server.PublicZone
	if !stringContains(dns.upserts, newHost) || !stringContains(dns.deletedHosts(), newHost) {
		t.Fatalf("DNS cleanup upserts=%v deletes=%v", dns.upserts, dns.deletedHosts())
	}
}

func TestDomainProvisioningIsFencedAcrossUnbindRevokeAndRepair(t *testing.T) {
	for _, actionName := range []string{"unbind", "revoke"} {
		t.Run(actionName, func(t *testing.T) {
			d := testDeps(t)
			acctH := AccountHandler{Deps: d}
			devH := DeviceHandler{Deps: d}
			cookieA := registerAccount(t, acctH, "fence-a-"+actionName+"@b.co")
			cookieB := registerAccount(t, acctH, "fence-b-"+actionName+"@b.co")
			verifyEmailFor(t, acctH, "fence-a-"+actionName+"@b.co")
			verifyEmailFor(t, acctH, "fence-b-"+actionName+"@b.co")
			_, uid := mintDevice(t, d, "official")
			devID, _ := pairDeviceForAccount(t, acctH, devH, cookieA, uid)

			tunnel := &fenceTunnel{Tunnel: d.Tunnel, started: make(chan struct{}), release: make(chan struct{})}
			dns := &fenceDNS{DNS: d.DNS}
			d.Tunnel, d.DNS = tunnel, dns
			// DeviceHandler copied Deps before the swap; point it at the wrappers.
			devH.Deps = d
			domainDone := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				req := httptest.NewRequest(http.MethodPost, "/devices/"+devID+"/domain", bytes.NewBufferString(`{"subdomain":"fencedbox"}`))
				req.AddCookie(cookieA)
				req = withChiParam(req, "deviceID", devID)
				domainDone <- withVerifiedAccount(acctH, devH.SetDomain, req)
			}()
			select {
			case <-tunnel.started:
			case <-time.After(2 * time.Second):
				t.Fatal("domain provisioning did not reach the provider")
			}

			actionDone := make(chan *httptest.ResponseRecorder, 1)
			go func() {
				method, path := http.MethodDelete, "/devices/"+devID
				if actionName == "revoke" {
					method, path = http.MethodPost, "/devices/"+devID+"/revoke"
				}
				req := httptest.NewRequest(method, path, nil)
				req.AddCookie(cookieA)
				req = withChiParam(req, "deviceID", devID)
				actionDone <- withVerifiedAccount(acctH, func(w http.ResponseWriter, r *http.Request) {
					if actionName == "revoke" {
						devH.Revoke(w, r)
						return
					}
					devH.Unbind(w, r)
				}, req)
			}()
			select {
			case rec := <-actionDone:
				t.Fatalf("%s crossed the provisioning fence: %d %s", actionName, rec.Code, rec.Body.String())
			case <-time.After(50 * time.Millisecond):
			}
			close(tunnel.release)
			domainRec := <-domainDone
			if domainRec.Code != http.StatusCreated {
				t.Fatalf("domain %d %s", domainRec.Code, domainRec.Body.String())
			}
			actionRec := <-actionDone
			if actionRec.Code != http.StatusOK {
				t.Fatalf("%s %d %s", actionName, actionRec.Code, actionRec.Body.String())
			}

			if actionName == "revoke" {
				req := httptest.NewRequest(http.MethodDelete, "/devices/"+devID,
					bytes.NewBufferString(`{"password":"hunter22hunter1"}`))
				req.AddCookie(cookieA)
				req = withChiParam(req, "deviceID", devID)
				if rec := withVerifiedAccount(acctH, devH.Unbind, req); rec.Code != http.StatusOK {
					t.Fatalf("unbind revoked device %d %s", rec.Code, rec.Body.String())
				}
			}
			_, _ = pairDeviceForAccount(t, acctH, devH, cookieB, uid)
			var state, accountID, subdomain, tunnelID, tunnelToken string
			if err := d.DB.QueryRow(`SELECT state, account_id, COALESCE(subdomain,''), COALESCE(tunnel_id,''), COALESCE(tunnel_token,'')
FROM devices WHERE id = ?`, devID).Scan(&state, &accountID, &subdomain, &tunnelID, &tunnelToken); err != nil {
				t.Fatal(err)
			}
			if state != "bound" || accountID == "" || subdomain != "" || tunnelID != "" || tunnelToken != "" {
				t.Fatalf("replacement inherited remote fields: state=%s account=%s sub=%q tunnel=%q token=%q", state, accountID, subdomain, tunnelID, tunnelToken)
			}
			created := tunnel.createdIDs()
			if len(created) != 1 || !stringContains(tunnel.deletedIDs(), created[0]) {
				t.Fatalf("current tunnel was not torn down: created=%v deleted=%v", created, tunnel.deletedIDs())
			}
			host := "fencedbox." + config.C.Server.PublicZone
			if !stringContains(dns.deletedHosts(), host) {
				t.Fatalf("current DNS record was not torn down: %v", dns.deletedHosts())
			}
		})
	}
}

func relinkDeviceForTest(t *testing.T, d Deps, acctH AccountHandler, devH DeviceHandler, oldToken string, cookie *http.Cookie, uid, subdomain string) (string, string) {
	t.Helper()
	old, err := loadDeviceByAuthToken(d.DB, oldToken)
	if err != nil {
		t.Fatal(err)
	}
	if err := unbindDevice(d, old, old.AccountID.String); err != nil {
		t.Fatal(err)
	}
	_, newToken := pairDeviceForAccount(t, acctH, devH, cookie, uid)
	rec := setAddress(t, acctH, devH, cookie, old.ID, subdomain)
	if rec.Code != http.StatusCreated && rec.Code != http.StatusOK {
		t.Fatalf("replacement domain %d %s", rec.Code, rec.Body.String())
	}
	var out struct {
		TunnelToken string `json:"tunnel_token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil || out.TunnelToken == "" {
		t.Fatalf("replacement tunnel token missing: %s (%v)", rec.Body.String(), err)
	}
	return newToken, out.TunnelToken
}

func TestStatusAndDomainRejectBearerAdmittedBeforeRelink(t *testing.T) {
	for _, route := range []string{"status", "domain"} {
		t.Run(route, func(t *testing.T) {
			d := testDeps(t)
			acctH := AccountHandler{Deps: d}
			devH := DeviceHandler{Deps: d}
			cookieA := registerAccount(t, acctH, "relink-a-"+route+"@b.co")
			cookieB := registerAccount(t, acctH, "relink-b-"+route+"@b.co")
			verifyEmailFor(t, acctH, "relink-a-"+route+"@b.co")
			verifyEmailFor(t, acctH, "relink-b-"+route+"@b.co")
			_, uid := mintDevice(t, d, "official")
			_, oldToken := pairDeviceForAccount(t, acctH, devH, cookieA, uid)
			if rec := setAddress(t, acctH, devH, cookieA, oldTokenDeviceID(t, d, oldToken), "oldbox"); rec.Code != http.StatusCreated {
				t.Fatalf("old domain %d %s", rec.Code, rec.Body.String())
			}

			next := http.HandlerFunc(devH.Status)
			path := "/api/v1/status"
			if route == "domain" {
				next = http.HandlerFunc(devH.Domain)
				path = "/api/v1/domain"
			}
			handler := devH.DeviceAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = relinkDeviceForTest(t, d, acctH, devH, oldToken, cookieB, uid, "newbox")
				next.ServeHTTP(w, r)
			}))
			body := []byte(nil)
			if route == "domain" {
				body = []byte(`{"subdomain":"newbox"}`)
			}
			req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body))
			if route == "status" {
				req = httptest.NewRequest(http.MethodGet, path, nil)
			}
			req.Header.Set("Authorization", "Bearer "+oldToken)
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			if rec.Code != http.StatusUnauthorized {
				t.Fatalf("stale bearer reached %s: %d %s", route, rec.Code, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "mock-token-luna-newbox") {
				t.Fatalf("stale bearer received replacement tunnel token: %s", rec.Body.String())
			}
		})
	}
}

func oldTokenDeviceID(t *testing.T, d Deps, token string) string {
	t.Helper()
	dev, err := loadDeviceByAuthToken(d.DB, token)
	if err != nil {
		t.Fatal(err)
	}
	return dev.ID
}

func TestStatusRejectsBearerAdmittedBeforeTokenRotation(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "rotate-race@b.co")
	verifyEmailFor(t, acctH, "rotate-race@b.co")
	_, uid := mintDevice(t, d, "official")
	devID, token := pairDeviceForAccount(t, acctH, devH, cookie, uid)
	if rec := setAddress(t, acctH, devH, cookie, devID, "rotatebox"); rec.Code != http.StatusCreated {
		t.Fatalf("domain %d %s", rec.Code, rec.Body.String())
	}
	handler := devH.DeviceAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, err := refreshDeviceToken(r.Context(), d.DB, token, time.Now().Unix()); err != nil {
			t.Errorf("rotate: %v", err)
		}
		devH.Status(w, r)
	}))
	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	rec := httptest.NewRecorder()
	handler.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized || strings.Contains(rec.Body.String(), "tunnel_token") {
		t.Fatalf("rotated-out bearer read status: %d %s", rec.Code, rec.Body.String())
	}
}
