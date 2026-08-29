package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

type recCloud struct {
	tunnels []string
	dns     []string
}

func (c *recCloud) CreateTunnel(_, _, name string) (*providers.TunnelCredentials, error) {
	return &providers.TunnelCredentials{TunnelID: "tun-" + name, Token: "tok-" + name}, nil
}
func (c *recCloud) ConfigureIngress(_, _, _, _, _ string) error { return nil }
func (c *recCloud) DeleteTunnel(_, _, tunnelID string) error {
	c.tunnels = append(c.tunnels, tunnelID)
	return nil
}
func (c *recCloud) UpsertCNAME(_, _, hostname, _ string) error { return nil }
func (c *recCloud) DeleteRecord(_, _, hostname string) error {
	c.dns = append(c.dns, hostname)
	return nil
}

func setupCookie(rec *httptest.ResponseRecorder) *http.Cookie {
	for _, c := range rec.Result().Cookies() {
		if c.Name == "luna_setup_session" {
			return c
		}
	}
	return nil
}

func pairOfficial(t *testing.T, onb OnboardingHandler, acct AccountHandler, cookie *http.Cookie, token, subdomain, remote string) *httptest.ResponseRecorder {
	t.Helper()
	bind := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+token+`"}`))
	bind.AddCookie(cookie)
	bind.RemoteAddr = remote
	brec := withOptionalAccount(acct, onb.Bind, bind)
	if brec.Code != 200 {
		t.Fatalf("bind %d %s", brec.Code, brec.Body.String())
	}
	att := httptest.NewRequest(http.MethodPost, "/onboarding/attach-account", nil)
	att.AddCookie(cookie)
	if sc := setupCookie(brec); sc != nil {
		att.AddCookie(sc)
	}
	arec := withAccount(acct, onb.AttachAccount, att)
	if arec.Code != 200 {
		t.Fatalf("attach %d %s", arec.Code, arec.Body.String())
	}
	registerHubSocket(t, onb, token, false)
	nameReq := httptest.NewRequest(http.MethodPost, "/onboarding/name", bytes.NewBufferString(`{"subdomain":"`+subdomain+`"}`))
	nameReq.AddCookie(cookie)
	if sc := setupCookie(arec); sc != nil {
		nameReq.AddCookie(sc)
	} else if sc := setupCookie(brec); sc != nil {
		nameReq.AddCookie(sc)
	}
	return withAccount(acct, onb.Name, nameReq)
}

func TestNameRejectsSecondLunaOnAccount(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	cookie := registerAccount(t, acct, "one@b.co")
	first := mintOfficial(t, onb)
	nrec := pairOfficial(t, onb, acct, cookie, first, "photos", "203.0.113.40:1")
	if nrec.Code != 201 {
		t.Fatalf("first name %d %s", nrec.Code, nrec.Body.String())
	}
	second := mintOfficial(t, onb)
	again := pairOfficial(t, onb, acct, cookie, second, "videos", "203.0.113.41:1")
	if again.Code != http.StatusConflict {
		t.Fatalf("second name %d %s", again.Code, again.Body.String())
	}
	if !strings.Contains(again.Body.String(), "already has a Luna") {
		t.Fatalf("copy %s", again.Body.String())
	}
}

func TestTransferMintTearsDownKeepsBackups(t *testing.T) {
	onb, acct, devH := testOnboarding(t)
	cloud := &recCloud{}
	onb.Tunnel, onb.DNS = cloud, cloud
	acct.Tunnel, acct.DNS = cloud, cloud
	devH.Tunnel, devH.DNS = cloud, cloud

	cookie := registerAccount(t, acct, "sell@b.co")
	token := mintOfficial(t, onb)
	nrec := pairOfficial(t, onb, acct, cookie, token, "photos", "203.0.113.50:1")
	if nrec.Code != 201 {
		t.Fatalf("name %d %s", nrec.Code, nrec.Body.String())
	}
	var acctID, deviceID, tunnelID string
	_ = acct.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'sell@b.co'`).Scan(&acctID)
	_ = acct.DB.QueryRow(`SELECT id, COALESCE(tunnel_id,'') FROM devices WHERE account_id = ?`, acctID).Scan(&deviceID, &tunnelID)
	_, _ = acct.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'active' WHERE id = ?`, acctID)
	if _, _, err := acct.Store.Put(acctID, deviceID, "Photos/a.jpg", strings.NewReader("keep-me")); err != nil {
		t.Fatal(err)
	}
	_, _ = acct.DB.Exec(`INSERT INTO backup_objects (id, account_id, device_id, relative_path, size, content_hash, updated_at)
VALUES ('obj_tx', ?, ?, 'Photos/a.jpg', 7, 'h', ?)`, acctID, deviceID, time.Now().Unix())

	mint := httptest.NewRequest(http.MethodPost, "/account/transfer-token", nil)
	mint.AddCookie(cookie)
	mrec := withAccount(acct, acct.TransferToken, mint)
	if mrec.Code != http.StatusCreated {
		t.Fatalf("transfer %d %s", mrec.Code, mrec.Body.String())
	}
	var minted map[string]any
	_ = json.Unmarshal(mrec.Body.Bytes(), &minted)
	code, _ := minted["code"].(string)
	if len(security.NormalizeToken(code)) < 16 {
		t.Fatalf("transfer code %q", code)
	}

	var n int
	_ = acct.DB.QueryRow(`SELECT COUNT(*) FROM devices WHERE id = ?`, deviceID).Scan(&n)
	if n != 0 {
		t.Fatal("device row should be gone")
	}
	_ = acct.DB.QueryRow(`SELECT COUNT(*) FROM backup_objects WHERE account_id = ?`, acctID).Scan(&n)
	if n != 1 {
		t.Fatalf("backups %d", n)
	}
	if len(cloud.tunnels) == 0 || cloud.tunnels[0] != tunnelID {
		t.Fatalf("tunnel delete %v want %s", cloud.tunnels, tunnelID)
	}
	if len(cloud.dns) == 0 || !strings.Contains(cloud.dns[0], "photos.") {
		t.Fatalf("dns delete %v", cloud.dns)
	}

	bak := BackupHandler{Deps: acct.Deps}
	dl := httptest.NewRequest(http.MethodPost, "/backups/download", bytes.NewBufferString(`{"device_id":"`+deviceID+`","path":"Photos/a.jpg"}`))
	dl.AddCookie(cookie)
	drec := withAccount(acct, bak.Download, dl)
	if drec.Code != 200 || !strings.Contains(drec.Body.String(), "keep-me") {
		t.Fatalf("seller download %d %s", drec.Code, drec.Body.String())
	}

	put := httptest.NewRequest(http.MethodPut, "/backup/objects/new.txt", strings.NewReader("nope"))
	put.Header.Set("Authorization", "Bearer leftover")
	put.SetPathValue("*", "new.txt")
	prec := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(bak.PutObject)).ServeHTTP(prec, put)
	if prec.Code != http.StatusUnauthorized {
		t.Fatalf("put after transfer %d %s", prec.Code, prec.Body.String())
	}

	var taken int
	_ = acct.DB.QueryRow(`SELECT COUNT(*) FROM devices WHERE subdomain = 'photos'`).Scan(&taken)
	if taken != 0 {
		t.Fatal("subdomain should be free")
	}
}

func TestTransferReplacesUnusedRemint(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	cookie := registerAccount(t, acct, "swap@b.co")
	token := mintOfficial(t, onb)
	if rec := pairOfficial(t, onb, acct, cookie, token, "swap", "203.0.113.60:1"); rec.Code != 201 {
		t.Fatalf("name %d %s", rec.Code, rec.Body.String())
	}
	remint := httptest.NewRequest(http.MethodPost, "/account/pairing-token", nil)
	remint.AddCookie(cookie)
	rrec := withAccount(acct, acct.PairingToken, remint)
	if rrec.Code != 201 {
		t.Fatalf("remint %d %s", rrec.Code, rrec.Body.String())
	}
	var minted map[string]any
	_ = json.Unmarshal(rrec.Body.Bytes(), &minted)
	old := minted["code"].(string)

	tx := httptest.NewRequest(http.MethodPost, "/account/transfer-token", nil)
	tx.AddCookie(cookie)
	trec := withAccount(acct, acct.TransferToken, tx)
	if trec.Code != 201 {
		t.Fatalf("transfer %d %s", trec.Code, trec.Body.String())
	}
	if tokenStatus(t, onb, old) != "replaced" {
		t.Fatalf("remint status %s", tokenStatus(t, onb, old))
	}
}

func TestTransferClaimActivatesBuyerAccount(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	seller := registerAccount(t, acct, "seller@b.co")
	tok := mintOfficial(t, onb)
	if rec := pairOfficial(t, onb, acct, seller, tok, "oldname", "203.0.113.70:1"); rec.Code != 201 {
		t.Fatalf("seller name %d %s", rec.Code, rec.Body.String())
	}
	tx := httptest.NewRequest(http.MethodPost, "/account/transfer-token", nil)
	tx.AddCookie(seller)
	trec := withAccount(acct, acct.TransferToken, tx)
	if trec.Code != 201 {
		t.Fatalf("transfer %d %s", trec.Code, trec.Body.String())
	}
	var minted map[string]any
	_ = json.Unmarshal(trec.Body.Bytes(), &minted)
	code := minted["code"].(string)

	buyer := registerAccount(t, acct, "buyer@b.co")
	brec := pairOfficial(t, onb, acct, buyer, code, "newname", "203.0.113.71:1")
	if brec.Code != 201 {
		t.Fatalf("buyer name %d %s", brec.Code, brec.Body.String())
	}
	if tokenStatus(t, onb, code) != "claimed" {
		t.Fatalf("transfer status %s", tokenStatus(t, onb, code))
	}
	var sellerOn, buyerOn int64
	_ = acct.DB.QueryRow(`SELECT COALESCE(activated_at,0) FROM accounts WHERE email = 'seller@b.co'`).Scan(&sellerOn)
	_ = acct.DB.QueryRow(`SELECT COALESCE(activated_at,0) FROM accounts WHERE email = 'buyer@b.co'`).Scan(&buyerOn)
	if sellerOn == 0 || buyerOn == 0 {
		t.Fatalf("activation seller=%d buyer=%d", sellerOn, buyerOn)
	}
	var buyerDev int
	_ = acct.DB.QueryRow(`SELECT COUNT(*) FROM devices WHERE subdomain = 'newname'`).Scan(&buyerDev)
	if buyerDev != 1 {
		t.Fatal("buyer should own the new name")
	}
}

func TestTransferRequiresLiveDevice(t *testing.T) {
	_, acct, _ := testOnboarding(t)
	cookie := registerAccount(t, acct, "nodev@b.co")
	_, _ = acct.DB.Exec(`UPDATE accounts SET activated_at = ? WHERE email = 'nodev@b.co'`, time.Now().Unix())
	req := httptest.NewRequest(http.MethodPost, "/account/transfer-token", nil)
	req.AddCookie(cookie)
	rec := withAccount(acct, acct.TransferToken, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("no device %d %s", rec.Code, rec.Body.String())
	}
}
