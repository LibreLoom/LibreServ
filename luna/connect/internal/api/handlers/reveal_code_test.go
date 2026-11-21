package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// revealSetup registers a verified account, mints a device and binds it, and
// returns the session cookie, device id and full token.
func revealSetup(t *testing.T, email string) (AccountHandler, DeviceHandler, *http.Cookie, string, string) {
	t.Helper()
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, email)
	verifyEmailFor(t, acctH, email)
	devID, code := mintDevice(t, d, "official")
	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	if rec := withVerifiedAccount(acctH, devH.Bind, bindReq); rec.Code != http.StatusOK {
		t.Fatalf("bind %d %s", rec.Code, rec.Body.String())
	}
	return acctH, devH, cookie, devID, code
}

func revealRequest(acctH AccountHandler, cookie *http.Cookie, devID, password string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"password": password})
	req := httptest.NewRequest(http.MethodPost, "/account/devices/"+devID+"/code", bytes.NewReader(body))
	req.AddCookie(cookie)
	req = withChiParam(req, "deviceID", devID)
	return withVerifiedAccount(acctH, acctH.RevealDeviceCode, req)
}

func TestRevealDeviceCodeNeedsCorrectPassword(t *testing.T) {
	acctH, _, cookie, devID, code := revealSetup(t, "reveal@b.co")

	rec := revealRequest(acctH, cookie, devID, "hunter22hunter1")
	if rec.Code != http.StatusOK {
		t.Fatalf("correct password: %d %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["code"] == nil || body["code"] == "" {
		t.Fatalf("correct password must return the token: %v", body)
	}
	if !strings.EqualFold(strings.ReplaceAll(body["code"].(string), "-", ""), strings.ReplaceAll(code, "-", "")) {
		t.Fatalf("returned token %q does not match minted %q", body["code"], code)
	}
}

func TestRevealDeviceCodeWrongPasswordIsChargedAndHidesToken(t *testing.T) {
	acctH, _, cookie, devID, code := revealSetup(t, "wrong@b.co")

	rec := revealRequest(acctH, cookie, devID, "not-the-password-1")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("wrong password: want 403, got %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), code) || strings.Contains(rec.Body.String(), `"code"`) {
		t.Fatalf("wrong password must not return the token: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), revealWrongPassword) {
		t.Fatalf("want the wrong-password sentence, got %s", rec.Body.String())
	}
	var count int
	if err := acctH.DB.QueryRow(`SELECT count FROM guess_attempts WHERE key = ?`, signInAccountKey("customer", "wrong@b.co")).Scan(&count); err != nil {
		t.Fatalf("wrong password must be charged to the sign-in bucket: %v", err)
	}
	if count != 1 {
		t.Fatalf("sign-in bucket count = %d, want 1", count)
	}
}

func TestRevealDeviceCodeEmptyPasswordRefused(t *testing.T) {
	acctH, _, cookie, devID, _ := revealSetup(t, "empty@b.co")

	rec := revealRequest(acctH, cookie, devID, "")
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("empty password: want 400, got %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"code"`) {
		t.Fatalf("empty password must not return the token: %s", rec.Body.String())
	}
}

func TestRevealDeviceCodeCappedBucketGivesGeneric429(t *testing.T) {
	acctH, _, cookie, devID, _ := revealSetup(t, "capped@b.co")
	now := time.Now().Unix()
	if _, err := acctH.DB.Exec(`INSERT INTO guess_attempts (key, count, start, last) VALUES (?, ?, ?, ?)`,
		signInAccountKey("customer", "capped@b.co"), signInAccountAttemptMax, now, now); err != nil {
		t.Fatal(err)
	}

	rec := revealRequest(acctH, cookie, devID, "not-the-password-1")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("capped bucket + wrong password: want 429, got %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"code"`) {
		t.Fatalf("capped bucket must not return the token: %s", rec.Body.String())
	}

	// The cap is not a lockout: the right password still works and clears it.
	rec = revealRequest(acctH, cookie, devID, "hunter22hunter1")
	if rec.Code != http.StatusOK {
		t.Fatalf("capped bucket + correct password: want 200, got %d %s", rec.Code, rec.Body.String())
	}
	var n int
	_ = acctH.DB.QueryRow(`SELECT COUNT(*) FROM guess_attempts WHERE key = ?`, signInAccountKey("customer", "capped@b.co")).Scan(&n)
	if n != 0 {
		t.Fatal("a correct password must clear the sign-in bucket")
	}
}

func TestRevealDeviceCodeOtherAccountsDeviceIsNotFound(t *testing.T) {
	acctH, _, _, devID, _ := revealSetup(t, "owner@b.co")
	other := registerAccount(t, acctH, "other@b.co")
	verifyEmailFor(t, acctH, "other@b.co")

	rec := revealRequest(acctH, other, devID, "hunter22hunter1")
	if rec.Code != http.StatusNotFound {
		t.Fatalf("other account's device: want 404, got %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), `"code"`) {
		t.Fatalf("other account must not see the token: %s", rec.Body.String())
	}
}

// insertBareAccount adds an account row directly, for tests that only need
// the id to exist (devices.account_id references accounts).
func insertBareAccount(t *testing.T, d Deps, id string) {
	t.Helper()
	if _, err := d.DB.Exec(`INSERT INTO accounts (id, email, password_hash, created_at) VALUES (?, ?, 'x', ?)`,
		id, id+"@b.co", time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
}

// claimDevice is the conditional link Bind runs after its checks. When another
// account wins the race between Bind's read and its write, the UPDATE changes
// no row, and Bind must answer 409 instead of reporting a link that never landed.
func TestClaimDeviceLosesRaceToAnotherAccount(t *testing.T) {
	d := testDeps(t)
	insertBareAccount(t, d, "acct_winner")
	insertBareAccount(t, d, "acct_loser")
	devID, _ := mintDevice(t, d, "official")
	if _, err := d.DB.Exec(`UPDATE devices SET account_id = ? WHERE id = ?`, "acct_winner", devID); err != nil {
		t.Fatal(err)
	}

	claimed, err := claimDevice(d.DB, devID, "acct_loser")
	if !errors.Is(err, errDeviceTakenByOther) {
		t.Fatalf("want errDeviceTakenByOther, got claimed=%v err=%v", claimed, err)
	}
	var owner string
	_ = d.DB.QueryRow(`SELECT account_id FROM devices WHERE id = ?`, devID).Scan(&owner)
	if owner != "acct_winner" {
		t.Fatalf("the winner's link must stay, got %q", owner)
	}
}

func TestClaimDeviceAlreadyThisAccount(t *testing.T) {
	d := testDeps(t)
	insertBareAccount(t, d, "acct_me")
	devID, _ := mintDevice(t, d, "official")
	if _, err := d.DB.Exec(`UPDATE devices SET account_id = ? WHERE id = ?`, "acct_me", devID); err != nil {
		t.Fatal(err)
	}

	claimed, err := claimDevice(d.DB, devID, "acct_me")
	if err != nil || claimed {
		t.Fatalf("a device already on this account: want claimed=false err=nil, got claimed=%v err=%v", claimed, err)
	}
}

func TestClaimDeviceLinksUnlinkedDevice(t *testing.T) {
	d := testDeps(t)
	insertBareAccount(t, d, "acct_me")
	devID, _ := mintDevice(t, d, "official")

	claimed, err := claimDevice(d.DB, devID, "acct_me")
	if err != nil || !claimed {
		t.Fatalf("an unlinked device: want claimed=true err=nil, got claimed=%v err=%v", claimed, err)
	}
}
