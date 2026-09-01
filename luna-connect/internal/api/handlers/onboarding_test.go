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

	_, code := mintDevice(t, d, "official")
	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	bindRec := withVerifiedAccount(acctH, devH.Bind, bindReq)
	if bindRec.Code != http.StatusOK {
		t.Fatalf("bind %d %s", bindRec.Code, bindRec.Body.String())
	}

	_, _ = d.DB.Exec(`UPDATE accounts SET onboarding_path = 'official', onboarding_step = 'code' WHERE email = ?`, "bound@b.co")

	statusReq := httptest.NewRequest(http.MethodGet, "/onboarding/status", nil)
	statusReq.AddCookie(cookie)
	statusRec := withVerifiedAccount(acctH, onbH.Status, statusReq)
	if statusRec.Code != http.StatusOK {
		t.Fatalf("status %d %s", statusRec.Code, statusRec.Body.String())
	}
	var status map[string]any
	_ = json.Unmarshal(statusRec.Body.Bytes(), &status)
	if status["step"] != "domain" {
		t.Fatalf("expected domain step, got %v", status["step"])
	}
	if status["skip_code_entry"] != true {
		t.Fatalf("expected skip_code_entry true, got %v", status["skip_code_entry"])
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
	if me["onboarding_step"] != "domain" {
		t.Fatalf("me step: %v", me["onboarding_step"])
	}
	if me["has_bound_device"] != true {
		t.Fatalf("me has_bound_device: %v", me["has_bound_device"])
	}
}

func TestBindRejectsSecondLuna(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "one@b.co")
	verifyEmailFor(t, acctH, "one@b.co")

	_, code1 := mintDevice(t, d, "official")
	bind1 := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code1+`"}`))
	bind1.AddCookie(cookie)
	bindRec1 := withVerifiedAccount(acctH, devH.Bind, bind1)
	if bindRec1.Code != http.StatusOK {
		t.Fatalf("first bind %d", bindRec1.Code)
	}

	_, code2 := mintDevice(t, d, "official")
	bind2 := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code2+`"}`))
	bind2.AddCookie(cookie)
	bindRec2 := withVerifiedAccount(acctH, devH.Bind, bind2)
	if bindRec2.Code != http.StatusConflict {
		t.Fatalf("second bind expected 409, got %d %s", bindRec2.Code, bindRec2.Body.String())
	}
}

func TestUnbindResetsOnboardingToCode(t *testing.T) {
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookie := registerAccount(t, acctH, "unbind@b.co")
	verifyEmailFor(t, acctH, "unbind@b.co")

	devID, code := mintDevice(t, d, "official")
	bindReq := httptest.NewRequest(http.MethodPost, "/devices/bind", bytes.NewBufferString(`{"code":"`+code+`"}`))
	bindReq.AddCookie(cookie)
	withVerifiedAccount(acctH, devH.Bind, bindReq)

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
