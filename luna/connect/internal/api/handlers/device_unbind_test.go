package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func accountUnbindRequest(acctH AccountHandler, devH DeviceHandler, cookie *http.Cookie, deviceID, body string) *httptest.ResponseRecorder {
	var reader io.Reader
	if body != "" {
		reader = strings.NewReader(body)
	}
	req := httptest.NewRequest(http.MethodDelete, "/devices/"+deviceID, reader)
	req.AddCookie(cookie)
	req = withChiParam(req, "deviceID", deviceID)
	return withVerifiedAccount(acctH, devH.Unbind, req)
}

func accountRevokeRequest(acctH AccountHandler, devH DeviceHandler, cookie *http.Cookie, deviceID string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPost, "/devices/"+deviceID+"/revoke", nil)
	req.AddCookie(cookie)
	req = withChiParam(req, "deviceID", deviceID)
	return withVerifiedAccount(acctH, devH.Revoke, req)
}

func assertAccountDeviceUnbound(t *testing.T, d Deps, deviceID string) {
	t.Helper()
	var state string
	var account sql.NullString
	var revoked int
	if err := d.DB.QueryRow(`SELECT state, account_id, revoked FROM devices WHERE id = ?`, deviceID).
		Scan(&state, &account, &revoked); err != nil {
		t.Fatal(err)
	}
	if state != "unbound" || account.Valid || revoked != 0 {
		t.Fatalf("device not unbound: state=%q account=%v revoked=%d", state, account, revoked)
	}
	for _, table := range []string{"device_pairings", "device_setup_grants"} {
		var count int
		if err := d.DB.QueryRow(`SELECT COUNT(*) FROM `+table+` WHERE device_id = ?`, deviceID).Scan(&count); err != nil {
			t.Fatal(err)
		}
		if count != 0 {
			t.Fatalf("%s still has %d rows for disconnected device", table, count)
		}
	}
}

func assertAccountDeviceRevoked(t *testing.T, d Deps, deviceID, accountID string) {
	t.Helper()
	var state, owner string
	var revoked int
	if err := d.DB.QueryRow(`SELECT state, COALESCE(account_id,''), revoked FROM devices WHERE id = ?`, deviceID).
		Scan(&state, &owner, &revoked); err != nil {
		t.Fatal(err)
	}
	if state != "revoked" || owner != accountID || revoked != 1 {
		t.Fatalf("device not left revoked: state=%q owner=%q revoked=%d", state, owner, revoked)
	}
}

func TestAccountUnbindCancelsPairing(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "cancel-pair@b.co")
	verifyEmailFor(t, acctH, "cancel-pair@b.co")
	deviceID, uid, code := mintDevice(t, d, "official")

	started := startPairRequest(t, acctH, devH, cookie, uid, code)
	if started.Code != http.StatusOK {
		t.Fatalf("start pairing %d %s", started.Code, started.Body.String())
	}
	var startBody struct {
		PairingID string `json:"pairing_id"`
	}
	if err := json.Unmarshal(started.Body.Bytes(), &startBody); err != nil || startBody.PairingID == "" {
		t.Fatalf("invalid pairing response: %s (%v)", started.Body.String(), err)
	}

	rec := accountUnbindRequest(acctH, devH, cookie, deviceID, "")
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"unbound"`) {
		t.Fatalf("disconnect pairing %d %s", rec.Code, rec.Body.String())
	}
	assertAccountDeviceUnbound(t, d, deviceID)
	if status := pairingStatusRequest(t, acctH, devH, cookie, startBody.PairingID); status.Code != http.StatusNotFound {
		t.Fatalf("cancelled pairing status %d %s", status.Code, status.Body.String())
	}
	if claim := claimPairRequest(devH, uid, code); claim.Code != http.StatusNotFound {
		t.Fatalf("cancelled pairing was claimed: %d %s", claim.Code, claim.Body.String())
	}
	if _, token := pairDeviceForAccount(t, acctH, devH, cookie, uid, code); !security.ValidAuthToken(token) {
		t.Fatal("cancelled identity could not be paired again")
	}
}

func TestAccountUnbindRevokedRequiresPassword(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "revoked-step-up@b.co")
	verifyEmailFor(t, acctH, "revoked-step-up@b.co")
	deviceID, uid, code := mintDevice(t, d, "official")
	_, token := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)
	if rec := accountRevokeRequest(acctH, devH, cookie, deviceID); rec.Code != http.StatusOK {
		t.Fatalf("revoke %d %s", rec.Code, rec.Body.String())
	}
	var accountID string
	if err := d.DB.QueryRow(`SELECT id FROM accounts WHERE email = ?`, "revoked-step-up@b.co").Scan(&accountID); err != nil {
		t.Fatal(err)
	}

	for _, tt := range []struct {
		name   string
		body   string
		status int
	}{
		{name: "missing password", status: http.StatusBadRequest},
		{name: "wrong password", body: `{"password":"not-the-password-1"}`, status: http.StatusForbidden},
	} {
		t.Run(tt.name, func(t *testing.T) {
			rec := accountUnbindRequest(acctH, devH, cookie, deviceID, tt.body)
			if rec.Code != tt.status || strings.Contains(rec.Body.String(), `"status":"unbound"`) {
				t.Fatalf("disconnect without step-up: %d %s", rec.Code, rec.Body.String())
			}
			assertAccountDeviceRevoked(t, d, deviceID, accountID)
			assertDeviceCredentialError(t, statusWithToken(devH, token), http.StatusForbidden, deviceRevokedCode)
		})
	}

	var failures int
	if err := d.DB.QueryRow(`SELECT count FROM guess_attempts WHERE key = ?`,
		signInAccountKey("customer", "revoked-step-up@b.co")).Scan(&failures); err != nil || failures != 1 {
		t.Fatalf("wrong-password failures=%d err=%v", failures, err)
	}
}

func TestAccountUnbindRevokedWithPassword(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "revoked-disconnect@b.co")
	verifyEmailFor(t, acctH, "revoked-disconnect@b.co")
	deviceID, uid, code := mintDevice(t, d, "official")
	_, token := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)
	if rec := accountRevokeRequest(acctH, devH, cookie, deviceID); rec.Code != http.StatusOK {
		t.Fatalf("revoke %d %s", rec.Code, rec.Body.String())
	}

	body, err := json.Marshal(map[string]string{"password": "hunter22hunter1"})
	if err != nil {
		t.Fatal(err)
	}
	rec := accountUnbindRequest(acctH, devH, cookie, deviceID, string(body))
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"status":"unbound"`) {
		t.Fatalf("disconnect revoked Luna %d %s", rec.Code, rec.Body.String())
	}
	assertAccountDeviceUnbound(t, d, deviceID)
	assertDeviceCredentialError(t, statusWithToken(devH, token), http.StatusForbidden, deviceUnboundCode)
	if _, err := refreshDeviceToken(context.Background(), d.DB, token, time.Now().Unix()); !errors.Is(err, errDeviceUnbound) {
		t.Fatalf("disconnected token refresh error=%v", err)
	}

	// The reusable identity survives both revocation and the stepped-up unbind.
	started := startPairRequest(t, acctH, devH, cookie, uid, code)
	if started.Code != http.StatusOK {
		t.Fatalf("re-pair after revoked disconnect %d %s", started.Code, started.Body.String())
	}
	if claim := claimPairRequest(devH, uid, code); claim.Code != http.StatusOK {
		t.Fatalf("claim after revoked disconnect %d %s", claim.Code, claim.Body.String())
	}
}

func TestAccountUnbindOtherAccountCannotDisconnect(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	owner := registerAccount(t, acctH, "unbind-owner@b.co")
	other := registerAccount(t, acctH, "unbind-other@b.co")
	verifyEmailFor(t, acctH, "unbind-owner@b.co")
	verifyEmailFor(t, acctH, "unbind-other@b.co")
	deviceID, uid, code := mintDevice(t, d, "official")
	_, token := pairDeviceForAccount(t, acctH, devH, owner, uid, code)

	rec := accountUnbindRequest(acctH, devH, other, deviceID, "")
	if rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), `"status":"unbound"`) {
		t.Fatalf("other-account disconnect %d %s", rec.Code, rec.Body.String())
	}
	if status := statusWithToken(devH, token); status.Code != http.StatusOK {
		t.Fatalf("other account disconnected the Luna: %d %s", status.Code, status.Body.String())
	}
}

func TestAccountUnbindRevokedPasswordResponseIsNotCacheable(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "revoked-cache@b.co")
	verifyEmailFor(t, acctH, "revoked-cache@b.co")
	deviceID, uid, code := mintDevice(t, d, "official")
	pairDeviceForAccount(t, acctH, devH, cookie, uid, code)
	if rec := accountRevokeRequest(acctH, devH, cookie, deviceID); rec.Code != http.StatusOK {
		t.Fatalf("revoke %d %s", rec.Code, rec.Body.String())
	}

	rec := accountUnbindRequest(acctH, devH, cookie, deviceID, `{"password":"wrong-password-1"}`)
	if rec.Code != http.StatusForbidden || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("password response %d cache-control=%q body=%s", rec.Code, rec.Header().Get("Cache-Control"), rec.Body.String())
	}
}
