package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

func mintDevice(t *testing.T, d Deps, kind string) (id, uid, code string) {
	t.Helper()
	id, uid, code, err := insertDeviceIdentity(d.DB, kind, "")
	if err != nil {
		t.Fatal(err)
	}
	return id, uid, code
}

func pairDeviceForAccount(t *testing.T, acctH AccountHandler, devH DeviceHandler, cookie *http.Cookie, uid, code string) (deviceID, authToken string) {
	t.Helper()
	body, _ := json.Marshal(pairingInput{DeviceUID: uid, VerificationCode: code})
	startReq := httptest.NewRequest(http.MethodPost, "/devices/pair", bytes.NewReader(body))
	startReq.AddCookie(cookie)
	startRec := withVerifiedAccount(acctH, devH.StartPair, startReq)
	if startRec.Code != http.StatusOK {
		t.Fatalf("start pair %d %s", startRec.Code, startRec.Body.String())
	}
	var started map[string]any
	_ = json.Unmarshal(startRec.Body.Bytes(), &started)
	pairingID, _ := started["pairing_id"].(string)
	if pairingID == "" {
		t.Fatalf("missing pairing id: %v", started)
	}

	claimReq := httptest.NewRequest(http.MethodPost, "/devices/pair/claim", bytes.NewReader(body))
	claimRec := httptest.NewRecorder()
	devH.ClaimPair(claimRec, claimReq)
	if claimRec.Code != http.StatusOK {
		t.Fatalf("claim pair %d %s", claimRec.Code, claimRec.Body.String())
	}
	var claimed map[string]any
	_ = json.Unmarshal(claimRec.Body.Bytes(), &claimed)
	deviceID, _ = claimed["device_id"].(string)
	authToken, _ = claimed["auth_token"].(string)
	if deviceID == "" || !security.ValidAuthToken(authToken) {
		t.Fatalf("invalid claim response: %v", claimed)
	}
	return deviceID, authToken
}

func TestPairClaimStatusUnbindAndIdentityReuse(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "owner@b.co")
	verifyEmailFor(t, acctH, "owner@b.co")
	devID, uid, code := mintDevice(t, d, "official")

	legacy := httptest.NewRequest(http.MethodGet, "/status", nil)
	legacy.Header.Set("Authorization", "Bearer "+uid)
	legacyRec := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(devH.Status)).ServeHTTP(legacyRec, legacy)
	if legacyRec.Code != http.StatusUnauthorized {
		t.Fatalf("public UID must not authenticate: %d %s", legacyRec.Code, legacyRec.Body.String())
	}

	_, token := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)
	status := func(token string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodGet, "/status", nil)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		devH.DeviceAuth(http.HandlerFunc(devH.Status)).ServeHTTP(rec, req)
		return rec
	}
	if rec := status(token); rec.Code != http.StatusOK {
		t.Fatalf("bound status %d %s", rec.Code, rec.Body.String())
	}

	// UID and code remain provisioned but cannot claim again while bound.
	body, _ := json.Marshal(pairingInput{DeviceUID: uid, VerificationCode: code})
	reclaim := httptest.NewRequest(http.MethodPost, "/devices/pair/claim", bytes.NewReader(body))
	reclaimRec := httptest.NewRecorder()
	devH.ClaimPair(reclaimRec, reclaim)
	if reclaimRec.Code != http.StatusNotFound {
		t.Fatalf("bound reclaim %d %s", reclaimRec.Code, reclaimRec.Body.String())
	}

	unReq := httptest.NewRequest(http.MethodDelete, "/devices/"+devID, nil)
	unReq.AddCookie(cookie)
	unReq = withChiParam(unReq, "deviceID", devID)
	unRec := withVerifiedAccount(acctH, devH.Unbind, unReq)
	if unRec.Code != http.StatusOK || !strings.Contains(unRec.Body.String(), `"status":"unbound"`) {
		t.Fatalf("unbind %d %s", unRec.Code, unRec.Body.String())
	}
	assertAccountDeviceUnbound(t, d, devID)
	assertDeviceCredentialError(t, status(token), http.StatusForbidden, deviceUnboundCode)
	var state, storedUID, storedCode string
	if err := d.DB.QueryRow(`SELECT state, device_uid, verification_code_hash FROM devices WHERE id = ?`, devID).
		Scan(&state, &storedUID, &storedCode); err != nil {
		t.Fatal(err)
	}
	if state != "unbound" || storedUID != uid || storedCode == "" {
		t.Fatalf("identity not retained: state=%s uid=%s code_hash=%s", state, storedUID, storedCode)
	}

	_, nextToken := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)
	if nextToken == token {
		t.Fatal("re-pairing must issue a new credential")
	}
	if rec := status(token); rec.Code != http.StatusUnauthorized {
		t.Fatalf("old credential after re-pair %d", rec.Code)
	}
	if rec := status(nextToken); rec.Code != http.StatusOK {
		t.Fatalf("new credential after re-pair %d %s", rec.Code, rec.Body.String())
	}
}

func TestSetDomainFailsWithoutAtRestKey(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "seal@b.co")
	verifyEmailFor(t, acctH, "seal@b.co")
	_, uid, code := mintDevice(t, d, "official")
	devID, _ := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)

	config.C.Server.AtRestKey = ""
	t.Setenv("LUNACONNECT_DEV", "")
	domReq := httptest.NewRequest(http.MethodPost, "/devices/"+devID+"/domain", bytes.NewBufferString(`{"subdomain":"photos"}`))
	domReq.AddCookie(cookie)
	domReq = withChiParam(domReq, "deviceID", devID)
	domRec := withVerifiedAccount(acctH, devH.SetDomain, domReq)
	if domRec.Code != http.StatusServiceUnavailable {
		t.Fatalf("expected 503, got %d %s", domRec.Code, domRec.Body.String())
	}
}

func TestSetDomainFailsWithoutCloudflareInProduction(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "cf@b.co")
	verifyEmailFor(t, acctH, "cf@b.co")
	_, uid, code := mintDevice(t, d, "official")
	devID, _ := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)

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
	_, uid, code := mintDevice(t, d, "official")
	devID, _ := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)

	svc := providers.NewService(d.DB)
	_, err := svc.Create("cloudflare", "Cloudflare", map[string]string{
		"account_id": "cf-account", "api_token": "cf-token",
	}, map[string]string{"zone_id": "cf-zone"}, true)
	if err != nil {
		t.Fatal(err)
	}
	providers.RefreshCloudflare()
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
	_, uid, code := mintDevice(t, d, "official")
	devID, _ := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)

	set := func() *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/devices/"+devID+"/domain", bytes.NewBufferString(`{"subdomain":"photos"}`))
		req.AddCookie(cookie)
		req = withChiParam(req, "deviceID", devID)
		return withVerifiedAccount(acctH, devH.SetDomain, req)
	}
	if rec := set(); rec.Code != http.StatusCreated && rec.Code != http.StatusOK {
		t.Fatalf("first domain %d %s", rec.Code, rec.Body.String())
	}
	second := set()
	if second.Code != http.StatusOK {
		t.Fatalf("repeat domain %d %s", second.Code, second.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(second.Body.Bytes(), &body)
	if body["hostname"] != "photos.luna.servers.libreloom.org" || body["tunnel_token"] == "" {
		t.Fatalf("same-subdomain response: %v", body)
	}
}

func TestDeviceDomainSameSubdomainReturnsTunnelToken(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "domain-same@b.co")
	verifyEmailFor(t, acctH, "domain-same@b.co")
	_, uid, code := mintDevice(t, d, "official")
	devID, token := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)

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

	domReq := httptest.NewRequest(http.MethodPost, "/api/v1/domain", bytes.NewBufferString(`{"subdomain":"yaya"}`))
	domReq.Header.Set("Authorization", "Bearer "+token)
	domRec := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(devH.Domain)).ServeHTTP(domRec, domReq)
	if domRec.Code != http.StatusOK {
		t.Fatalf("device domain %d %s", domRec.Code, domRec.Body.String())
	}
	if domRec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("device domain cache control=%q", domRec.Header().Get("Cache-Control"))
	}
	var body map[string]any
	_ = json.Unmarshal(domRec.Body.Bytes(), &body)
	if body["hostname"] != "yaya.luna.servers.libreloom.org" || body["tunnel_token"] != wantTok || wantTok == "" {
		t.Fatalf("same-subdomain response: %v", body)
	}
}

func TestUnlinkKeepsPaidCloudCopies(t *testing.T) {
	for _, local := range []bool{false, true} {
		name := "account unbind"
		if local {
			name = "Luna unregister"
		}
		t.Run(name, func(t *testing.T) {
			d := testDeps(t)
			acctH := AccountHandler{Deps: d}
			devH := DeviceHandler{Deps: d}
			cookie := registerAccount(t, acctH, "paid@b.co")
			verifyEmailFor(t, acctH, "paid@b.co")
			var accountID string
			_ = d.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'paid@b.co'`).Scan(&accountID)
			_, uid, code := mintDevice(t, d, "official")
			devID, token := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)
			_, _ = d.DB.Exec(`UPDATE accounts SET billing_status = 'active' WHERE id = ?`, accountID)
			seedLunaWithPack(t, d, accountID, "paid-luna", devID, 0, strings.Repeat("a", 64))
			var rec *httptest.ResponseRecorder
			if local {
				req := httptest.NewRequest(http.MethodPost, "/unregister", nil)
				req.Header.Set("Authorization", "Bearer "+token)
				rec = httptest.NewRecorder()
				devH.DeviceAuth(http.HandlerFunc(devH.Unregister)).ServeHTTP(rec, req)
			} else {
				req := withChiParam(httptest.NewRequest(http.MethodDelete, "/devices/"+devID, nil), "deviceID", devID)
				req.AddCookie(cookie)
				rec = withVerifiedAccount(acctH, devH.Unbind, req)
			}
			if rec.Code != http.StatusOK {
				t.Fatalf("unlink %d %s", rec.Code, rec.Body.String())
			}
			ProcessRetention(d, time.Now().Unix()+365*86400)
			if countRows(t, d, `SELECT COUNT(*) FROM luna_ids WHERE account_id = ? AND luna_id = 'paid-luna' AND purge_after = 0`, accountID) != 1 {
				t.Fatal("paid Luna must have no unlink deadline")
			}
			if countRows(t, d, `SELECT COUNT(*) FROM storage_packs WHERE account_id = ? AND luna_id = 'paid-luna'`, accountID) != 1 {
				t.Fatal("paid storage must remain")
			}
		})
	}
}
