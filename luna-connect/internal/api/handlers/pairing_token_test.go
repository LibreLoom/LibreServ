package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func TestPairingTokenRequiresActivation(t *testing.T) {
	_, acct, _ := testOnboarding(t)
	cookie := registerAccount(t, acct, "idle@b.co")

	req := httptest.NewRequest(http.MethodPost, "/account/pairing-token", nil)
	req.AddCookie(cookie)
	rec := withAccount(acct, acct.PairingToken, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("idle remint %d %s", rec.Code, rec.Body.String())
	}

	me := httptest.NewRequest(http.MethodGet, "/account/me", nil)
	me.AddCookie(cookie)
	mrec := withAccount(acct, acct.Me, me)
	if mrec.Code != 200 {
		t.Fatalf("me %d %s", mrec.Code, mrec.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(mrec.Body.Bytes(), &body)
	if body["activated"] != false {
		t.Fatalf("new account should not be activated: %v", body)
	}
}

func TestOfficialAttachActivatesAndRemints(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	token := mintOfficial(t, onb)
	cookie := registerAccount(t, acct, "book@b.co")

	bind := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+token+`"}`))
	bind.AddCookie(cookie)
	bind.RemoteAddr = "203.0.113.80:1"
	brec := withOptionalAccount(acct, onb.Bind, bind)
	if brec.Code != 200 {
		t.Fatalf("bind %d %s", brec.Code, brec.Body.String())
	}

	att := httptest.NewRequest(http.MethodPost, "/onboarding/attach-account", nil)
	att.AddCookie(cookie)
	att.AddCookie(brec.Result().Cookies()[0])
	arec := withAccount(acct, onb.AttachAccount, att)
	if arec.Code != 200 {
		t.Fatalf("attach %d %s", arec.Code, arec.Body.String())
	}

	mint := httptest.NewRequest(http.MethodPost, "/account/pairing-token", nil)
	mint.AddCookie(cookie)
	mrec := withAccount(acct, acct.PairingToken, mint)
	if mrec.Code != http.StatusCreated {
		t.Fatalf("remint %d %s", mrec.Code, mrec.Body.String())
	}
	var minted map[string]any
	_ = json.Unmarshal(mrec.Body.Bytes(), &minted)
	code, _ := minted["code"].(string)
	if len(security.NormalizeToken(code)) < 16 {
		t.Fatalf("remint code too short %q", code)
	}
	if tokenStatus(t, onb, code) != "issued" {
		t.Fatalf("remint status %s", tokenStatus(t, onb, code))
	}

	again := httptest.NewRequest(http.MethodPost, "/account/pairing-token", nil)
	again.AddCookie(cookie)
	againRec := withAccount(acct, acct.PairingToken, again)
	if againRec.Code != http.StatusCreated {
		t.Fatalf("second remint %d %s", againRec.Code, againRec.Body.String())
	}
	if tokenStatus(t, onb, code) != "replaced" {
		t.Fatalf("old remint should be replaced, got %s", tokenStatus(t, onb, code))
	}

	var againBody map[string]any
	_ = json.Unmarshal(againRec.Body.Bytes(), &againBody)
	fresh := againBody["code"].(string)

	bind2 := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+fresh+`"}`))
	bind2.AddCookie(cookie)
	bind2.RemoteAddr = "203.0.113.81:1"
	b2 := withOptionalAccount(acct, onb.Bind, bind2)
	if b2.Code != 200 {
		t.Fatalf("bind remint %d %s", b2.Code, b2.Body.String())
	}

	other := registerAccount(t, acct, "other@b.co")
	steal := httptest.NewRequest(http.MethodPost, "/onboarding/bind", bytes.NewBufferString(`{"code":"`+fresh+`"}`))
	steal.AddCookie(other)
	steal.RemoteAddr = "203.0.113.82:1"
	srec := withOptionalAccount(acct, onb.Bind, steal)
	if srec.Code != http.StatusForbidden {
		t.Fatalf("other bind remint %d %s", srec.Code, srec.Body.String())
	}
}

func TestOSSVerifyActivatesAndRemints(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	cookie := registerAccount(t, acct, "byo@b.co")

	pay := httptest.NewRequest(http.MethodPost, "/account/verify-human", nil)
	pay.AddCookie(cookie)
	prec := withAccount(acct, onb.VerifyHuman, pay)
	if prec.Code != 200 {
		t.Fatalf("verify %d %s", prec.Code, prec.Body.String())
	}

	mint := httptest.NewRequest(http.MethodPost, "/account/pairing-token", nil)
	mint.AddCookie(cookie)
	mrec := withAccount(acct, acct.PairingToken, mint)
	if mrec.Code != http.StatusCreated {
		t.Fatalf("byo remint %d %s", mrec.Code, mrec.Body.String())
	}
}
