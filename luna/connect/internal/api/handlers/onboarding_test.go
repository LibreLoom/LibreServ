package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestOnboardingStatusSkipsCodeWhenBound(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	onbH := OnboardingHandler{Deps: d}
	cookie := registerAccount(t, acctH, "bound@b.co")
	verifyEmailFor(t, acctH, "bound@b.co")
	_, uid, code := mintDevice(t, d, "official")
	pairDeviceForAccount(t, acctH, devH, cookie, uid, code)
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
	_, uid1, code1 := mintDevice(t, d, "official")
	pairDeviceForAccount(t, acctH, devH, cookie, uid1, code1)

	_, uid2, code2 := mintDevice(t, d, "official")
	body, _ := json.Marshal(pairingInput{DeviceUID: uid2, VerificationCode: code2})
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
	_, uid, code := mintDevice(t, d, "official")
	devID, _ := pairDeviceForAccount(t, acctH, devH, cookie, uid, code)

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
