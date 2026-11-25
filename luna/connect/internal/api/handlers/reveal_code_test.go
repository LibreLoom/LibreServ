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

// revealSetup registers a verified account and pairs one Luna.
func revealSetup(t *testing.T, email string) (AccountHandler, DeviceHandler, *http.Cookie, string, string, string) {
	t.Helper()
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, email)
	verifyEmailFor(t, acctH, email)
	_, uid, code := mintDevice(t, d, "official")
	devID, _ := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)
	return acctH, devH, cookie, devID, uid, code
}

func revealRequest(acctH AccountHandler, cookie *http.Cookie, devID, password string) *httptest.ResponseRecorder {
	body, _ := json.Marshal(map[string]string{"password": password})
	req := httptest.NewRequest(http.MethodPost, "/account/devices/"+devID+"/code", bytes.NewReader(body))
	req.AddCookie(cookie)
	req = withChiParam(req, "deviceID", devID)
	return withVerifiedAccount(acctH, acctH.RevealDeviceCode, req)
}

func TestRevealDeviceCodeNeedsCorrectPassword(t *testing.T) {
	acctH, _, cookie, devID, uid, code := revealSetup(t, "reveal@b.co")
	rec := revealRequest(acctH, cookie, devID, "hunter22hunter1")
	if rec.Code != http.StatusOK {
		t.Fatalf("correct password: %d %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("reveal cache control=%q", rec.Header().Get("Cache-Control"))
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	if body["verification_code"] != code || security.NormalizeDeviceUID(body["device_uid"].(string)) != uid {
		t.Fatalf("wrong pairing details: %v", body)
	}
	if _, leaked := body["auth_token"]; leaked {
		t.Fatalf("reveal leaked rolling credential: %v", body)
	}
}

func TestRevealDeviceCodeWrongPasswordIsChargedAndHidesCode(t *testing.T) {
	acctH, _, cookie, devID, _, code := revealSetup(t, "wrong@b.co")
	rec := revealRequest(acctH, cookie, devID, "not-the-password-1")
	if rec.Code != http.StatusForbidden {
		t.Fatalf("wrong password: want 403, got %d %s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), code) || strings.Contains(rec.Body.String(), `"verification_code"`) {
		t.Fatalf("wrong password returned pairing details: %s", rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), revealWrongPassword) {
		t.Fatalf("want wrong-password sentence, got %s", rec.Body.String())
	}
	var count int
	if err := acctH.DB.QueryRow(`SELECT count FROM guess_attempts WHERE key = ?`, signInAccountKey("customer", "wrong@b.co")).Scan(&count); err != nil || count != 1 {
		t.Fatalf("sign-in bucket count=%d err=%v", count, err)
	}
}

func TestRevealDeviceCodeEmptyPasswordRefused(t *testing.T) {
	acctH, _, cookie, devID, _, _ := revealSetup(t, "empty@b.co")
	rec := revealRequest(acctH, cookie, devID, "")
	if rec.Code != http.StatusBadRequest || strings.Contains(rec.Body.String(), `"verification_code"`) {
		t.Fatalf("empty password: %d %s", rec.Code, rec.Body.String())
	}
}

func TestRevealDeviceCodeCappedBucketGivesGeneric429(t *testing.T) {
	acctH, _, cookie, devID, _, _ := revealSetup(t, "capped@b.co")
	now := time.Now().Unix()
	_, _ = acctH.DB.Exec(`INSERT INTO guess_attempts (key, count, start, last) VALUES (?, ?, ?, ?)`,
		signInAccountKey("customer", "capped@b.co"), signInAccountAttemptMax, now, now)
	if rec := revealRequest(acctH, cookie, devID, "not-the-password-1"); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("capped wrong password: %d %s", rec.Code, rec.Body.String())
	}
	if rec := revealRequest(acctH, cookie, devID, "hunter22hunter1"); rec.Code != http.StatusOK {
		t.Fatalf("capped correct password: %d %s", rec.Code, rec.Body.String())
	}
}

func TestRevealDeviceCodeOtherAccountsDeviceIsNotFound(t *testing.T) {
	acctH, _, _, devID, _, _ := revealSetup(t, "owner@b.co")
	other := registerAccount(t, acctH, "other@b.co")
	verifyEmailFor(t, acctH, "other@b.co")
	rec := revealRequest(acctH, other, devID, "hunter22hunter1")
	if rec.Code != http.StatusNotFound || strings.Contains(rec.Body.String(), `"verification_code"`) {
		t.Fatalf("other account: %d %s", rec.Code, rec.Body.String())
	}
}

// insertBareAccount adds an account row directly for tests that only need an id.
func insertBareAccount(t *testing.T, d Deps, id string) {
	t.Helper()
	_, err := d.DB.Exec(`INSERT INTO accounts (id, email, password_hash, created_at) VALUES (?, ?, 'x', ?)`,
		id, id+"@b.co", time.Now().Unix())
	if err != nil {
		t.Fatal(err)
	}
}
