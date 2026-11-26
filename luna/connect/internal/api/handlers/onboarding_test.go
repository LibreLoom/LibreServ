package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func TestOnboardingStatusSkipsCodeWhenBound(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	onbH := OnboardingHandler{Deps: d}
	cookie := registerAccount(t, acctH, "bound@b.co")
	verifyEmailFor(t, acctH, "bound@b.co")
	_, uid := mintDevice(t, d, "official")
	pairDeviceForAccount(t, acctH, devH, cookie, uid)
	_, _ = d.DB.Exec(`UPDATE accounts SET onboarding_path = 'official', onboarding_step = 'code' WHERE email = ?`, "bound@b.co")

	statusReq := httptest.NewRequest(http.MethodGet, "/onboarding/status", nil)
	statusReq.AddCookie(cookie)
	statusRec := withVerifiedAccount(acctH, onbH.Status, statusReq)
	if statusRec.Code != http.StatusOK {
		t.Fatalf("status %d %s", statusRec.Code, statusRec.Body.String())
	}
	var status map[string]any
	_ = json.Unmarshal(statusRec.Body.Bytes(), &status)
	if status["step"] != "domain" || status["skip_code_entry"] != true {
		t.Fatalf("unexpected onboarding status: %v", status)
	}

	meReq := httptest.NewRequest(http.MethodGet, "/account/me", nil)
	meReq.AddCookie(cookie)
	meRec := httptest.NewRecorder()
	acctH.AccountAuth(http.HandlerFunc(acctH.Me)).ServeHTTP(meRec, meReq)
	if meRec.Code != http.StatusOK {
		t.Fatalf("me %d %s", meRec.Code, meRec.Body.String())
	}
	var me map[string]any
	_ = json.Unmarshal(meRec.Body.Bytes(), &me)
	if me["onboarding_step"] != "domain" || me["has_bound_device"] != true {
		t.Fatalf("unexpected me state: %v", me)
	}
}

func TestPairRejectsSecondLuna(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "one@b.co")
	verifyEmailFor(t, acctH, "one@b.co")
	_, uid1 := mintDevice(t, d, "official")
	pairDeviceForAccount(t, acctH, devH, cookie, uid1)

	_, uid2 := mintDevice(t, d, "official")
	body, _ := json.Marshal(pairingInput{DeviceToken: uid2})
	req := httptest.NewRequest(http.MethodPost, "/devices/pair", bytes.NewReader(body))
	req.AddCookie(cookie)
	rec := withVerifiedAccount(acctH, devH.StartPair, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("second pair expected 409, got %d %s", rec.Code, rec.Body.String())
	}
}

func TestUnbindResetsOnboardingToCode(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "unbind@b.co")
	verifyEmailFor(t, acctH, "unbind@b.co")
	_, uid := mintDevice(t, d, "official")
	devID, _ := pairDeviceForAccount(t, acctH, devH, cookie, uid)

	unReq := httptest.NewRequest(http.MethodDelete, "/devices/"+devID, nil)
	unReq.AddCookie(cookie)
	unReq = withChiParam(unReq, "deviceID", devID)
	unRec := withVerifiedAccount(acctH, devH.Unbind, unReq)
	if unRec.Code != http.StatusOK {
		t.Fatalf("unbind %d", unRec.Code)
	}
	var step string
	_ = d.DB.QueryRow(`SELECT onboarding_step FROM accounts WHERE email = ?`, "unbind@b.co").Scan(&step)
	if step != "code" {
		t.Fatalf("onboarding_step after unbind: %s", step)
	}
}

func TestMintDIYReturnsOneTokenOnceAndStoresOnlyItsHash(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	onbH := OnboardingHandler{Deps: d}
	cookie := registerAccount(t, acctH, "diy@b.co")
	verifyEmailFor(t, acctH, "diy@b.co")

	req := httptest.NewRequest(http.MethodPost, "/account/diy-token", nil)
	req.AddCookie(cookie)
	rec := withVerifiedAccount(acctH, onbH.MintDIY, req)
	if rec.Code != http.StatusCreated || rec.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("DIY mint %d %s cache=%q", rec.Code, rec.Body.String(), rec.Header().Get("Cache-Control"))
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	token, _ := out["device_token"].(string)
	norm := security.NormalizeDeviceToken(token)
	if !security.IsDeviceTokenShape(norm) || token != security.GroupCrockford(norm) || out["device_id"] == "" {
		t.Fatalf("DIY mint output: %v", out)
	}
	var hash string
	if err := d.DB.QueryRow(`SELECT code_hash FROM devices WHERE id = ?`, out["device_id"]).Scan(&hash); err != nil || hash != security.HashToken(norm) {
		t.Fatalf("stored hash %q err=%v", hash, err)
	}
	// The minted token pairs, typed with grouping and lowercase.
	if rec := startPairRequest(t, acctH, devH, cookie, "  "+strings.ToLower(token)+" "); rec.Code != http.StatusOK {
		t.Fatalf("pair with minted DIY token: %d %s", rec.Code, rec.Body.String())
	}
}
