package handlers

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
)

func portalRequest(t *testing.T, h *PortalHandler, accountID, method, path, body string, fn func(http.ResponseWriter, *http.Request)) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	if accountID != "" {
		req = req.WithContext(middleware.WithCustomerDeviceID(req.Context(), accountID))
	}
	w := httptest.NewRecorder()
	fn(w, req)
	return w
}

func TestPortalRegisterVerifyAndLogin(t *testing.T) {
	db := database.OpenTestDB(t)
	seedEmailProvider(t, db)
	emailSent := make(chan struct{}, 1)
	resendMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		emailSent <- struct{}{}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"email-1"}`))
	}))
	defer resendMock.Close()

	h := NewPortalHandler(db)
	h.resend = providers.NewResendClientWithBaseURL(nil, resendMock.URL)

	for _, body := range []string{
		`{`,
		`{"email":"user@example.com","password":"short","username":"user-one"}`,
		`{"email":"user@example.com","password":"long-enough","username":""}`,
		`{"email":"user@example.com","password":"long-enough","username":"NO spaces"}`,
	} {
		w := portalRequest(t, h, "", http.MethodPost, "/portal/register", body, h.Register)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("register validation status = %d: %s", w.Code, w.Body.String())
		}
	}

	body := `{"email":"user@example.com","password":"long-enough","name":"User","username":"user-one","source":"onboarding"}`
	w := portalRequest(t, h, "", http.MethodPost, "/portal/register", body, h.Register)
	if w.Code != http.StatusOK {
		t.Fatalf("register status = %d: %s", w.Code, w.Body.String())
	}
	var registered map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &registered); err != nil {
		t.Fatalf("decode registration: %v", err)
	}
	accountID := registered["id"].(string)
	if registered["token"] == "" || registered["username"] != "user-one" {
		t.Fatalf("registration = %#v", registered)
	}
	select {
	case <-emailSent:
	case <-time.After(2 * time.Second):
		t.Fatal("verification email was not sent")
	}

	duplicate := portalRequest(t, h, "", http.MethodPost, "/portal/register", body, h.Register)
	if duplicate.Code != http.StatusConflict {
		t.Fatalf("duplicate register status = %d", duplicate.Code)
	}

	for _, login := range []struct {
		body string
		code int
	}{
		{`{`, http.StatusBadRequest},
		{`{"email":"missing@example.com","password":"long-enough"}`, http.StatusUnauthorized},
		{`{"email":"user@example.com","password":"wrong-password"}`, http.StatusUnauthorized},
		{`{"email":"user@example.com","password":"long-enough"}`, http.StatusOK},
	} {
		got := portalRequest(t, h, "", http.MethodPost, "/portal/login", login.body, h.Login)
		if got.Code != login.code {
			t.Fatalf("login %s status = %d: %s", login.body, got.Code, got.Body.String())
		}
	}

	badVerify := portalRequest(t, h, "", http.MethodPost, "/portal/verify-email", `{}`, h.VerifyEmail)
	if badVerify.Code != http.StatusBadRequest {
		t.Fatalf("empty verify status = %d", badVerify.Code)
	}
	badVerify = portalRequest(t, h, "", http.MethodPost, "/portal/verify-email", `{"token":"bad"}`, h.VerifyEmail)
	if badVerify.Code != http.StatusBadRequest {
		t.Fatalf("bad verify status = %d", badVerify.Code)
	}

	token, err := h.createEmailVerificationToken(t.Context(), accountID)
	if err != nil {
		t.Fatalf("create verification token: %v", err)
	}
	verified := portalRequest(t, h, "", http.MethodPost, "/portal/verify-email", `{"token":"`+token+`"}`, h.VerifyEmail)
	if verified.Code != http.StatusOK {
		t.Fatalf("verify status = %d: %s", verified.Code, verified.Body.String())
	}

	status := portalRequest(t, h, accountID, http.MethodGet, "/portal/verification-status", "", h.GetVerificationStatus)
	if status.Code != http.StatusOK || !strings.Contains(status.Body.String(), "true") {
		t.Fatalf("verification status = %d: %s", status.Code, status.Body.String())
	}
	me := portalRequest(t, h, accountID, http.MethodGet, "/portal/me", "", h.GetMe)
	if me.Code != http.StatusOK || !strings.Contains(me.Body.String(), "user@example.com") {
		t.Fatalf("me = %d: %s", me.Code, me.Body.String())
	}
}

func TestPortalTwoFactorLifecycle(t *testing.T) {
	db := database.OpenTestDB(t)
	accountID := newVerifiedAccount(t, db)
	hash, err := auth.HashPassword("long-enough")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE customer_accounts SET password_hash = $1 WHERE id = $2`, hash, accountID); err != nil {
		t.Fatal(err)
	}
	h := NewPortalHandler(db)

	setup := portalRequest(t, h, accountID, http.MethodPost, "/portal/2fa/setup", `{}`, h.Setup2FA)
	if setup.Code != http.StatusOK {
		t.Fatalf("setup 2FA = %d: %s", setup.Code, setup.Body.String())
	}
	var secret sql.NullString
	if err := db.QueryRow(`SELECT totp_secret FROM customer_accounts WHERE id = $1`, accountID).Scan(&secret); err != nil {
		t.Fatal(err)
	}
	code, err := auth.GenerateTOTPCode(secret.String, time.Now())
	if err != nil {
		t.Fatal(err)
	}

	for _, body := range []string{`{}`, `{"code":"000000"}`} {
		got := portalRequest(t, h, accountID, http.MethodPost, "/portal/2fa/verify", body, h.Verify2FA)
		if got.Code == http.StatusOK {
			t.Fatalf("invalid verify accepted: %s", body)
		}
	}
	verify := portalRequest(t, h, accountID, http.MethodPost, "/portal/2fa/verify", `{"code":"`+code+`"}`, h.Verify2FA)
	if verify.Code != http.StatusOK {
		t.Fatalf("verify 2FA = %d: %s", verify.Code, verify.Body.String())
	}

	loginMissingCode := portalRequest(t, h, "", http.MethodPost, "/portal/login",
		`{"email":"`+accountID+`@test.com","password":"long-enough"}`, h.Login)
	if loginMissingCode.Code != http.StatusOK || !strings.Contains(loginMissingCode.Body.String(), "requires_2fa") {
		t.Fatalf("login 2FA challenge = %d: %s", loginMissingCode.Code, loginMissingCode.Body.String())
	}
	login := portalRequest(t, h, "", http.MethodPost, "/portal/login",
		`{"email":"`+accountID+`@test.com","password":"long-enough","totp_code":"`+code+`"}`, h.Login)
	if login.Code != http.StatusOK || !strings.Contains(login.Body.String(), `"has_2fa":true`) {
		t.Fatalf("login with 2FA = %d: %s", login.Code, login.Body.String())
	}

	invalidDisable := portalRequest(t, h, accountID, http.MethodPost, "/portal/2fa/disable", `{}`, h.Disable2FA)
	if invalidDisable.Code != http.StatusBadRequest {
		t.Fatalf("empty disable = %d", invalidDisable.Code)
	}
	disable := portalRequest(t, h, accountID, http.MethodPost, "/portal/2fa/disable", `{"code":"`+code+`"}`, h.Disable2FA)
	if disable.Code != http.StatusOK {
		t.Fatalf("disable 2FA = %d: %s", disable.Code, disable.Body.String())
	}
}

func TestPortalConnectKeyAndCatalogViews(t *testing.T) {
	db := database.OpenTestDB(t)
	accountID := newVerifiedAccount(t, db)
	h := NewPortalHandler(db)

	plans := portalRequest(t, h, "", http.MethodGet, "/portal/plans", "", h.GetPlans)
	if plans.Code != http.StatusOK || !strings.Contains(plans.Body.String(), "Connect One") {
		t.Fatalf("plans = %d: %s", plans.Code, plans.Body.String())
	}
	if h.planDomain("missing") != "*.free.servers.libreloom.org" {
		t.Fatal("missing plan did not fall back to free")
	}
	if isValidUsername("AB") || isValidUsername("bad_name") || !isValidUsername("good-name1") {
		t.Fatal("username validation incorrect")
	}

	generated := portalRequest(t, h, accountID, http.MethodPost, "/portal/connect-keys", `{"subdomain":"test-home"}`, h.GenerateConnectKey)
	if generated.Code != http.StatusOK {
		t.Fatalf("generate key = %d: %s", generated.Code, generated.Body.String())
	}
	var payload map[string]any
	_ = json.Unmarshal(generated.Body.Bytes(), &payload)
	keyID := payload["key_id"].(string)

	keys := portalRequest(t, h, accountID, http.MethodGet, "/portal/connect-keys", "", h.GetConnectKeys)
	if keys.Code != http.StatusOK || !strings.Contains(keys.Body.String(), keyID) {
		t.Fatalf("keys = %d: %s", keys.Code, keys.Body.String())
	}
	missing := portalRequest(t, h, accountID, http.MethodPost, "/portal/connect-keys/revoke", `{}`, h.RevokeConnectKey)
	if missing.Code != http.StatusBadRequest {
		t.Fatalf("missing revoke key = %d", missing.Code)
	}
	revoked := portalRequest(t, h, accountID, http.MethodPost, "/portal/connect-keys/revoke", `{"key_id":"`+keyID+`"}`, h.RevokeConnectKey)
	if revoked.Code != http.StatusOK {
		t.Fatalf("revoke key = %d: %s", revoked.Code, revoked.Body.String())
	}

	noDevices := portalRequest(t, h, accountID, http.MethodGet, "/portal/devices", "", h.GetDevices)
	if noDevices.Code != http.StatusOK || !strings.Contains(noDevices.Body.String(), `"devices":[]`) {
		t.Fatalf("devices = %d: %s", noDevices.Code, noDevices.Body.String())
	}

	unverified := newUnverifiedAccount(t, db, "unverified-views@example.com")
	for i := 0; i < 3; i++ {
		if !h.emailRateLimitOK(unverified) {
			t.Fatalf("email send %d unexpectedly limited", i)
		}
	}
	if h.emailRateLimitOK(unverified) {
		t.Fatal("fourth email send was not rate limited")
	}
}

func TestPortalMissingAccountResponses(t *testing.T) {
	h := NewPortalHandler(database.OpenTestDB(t))
	for name, tc := range map[string]struct {
		path string
		fn   func(http.ResponseWriter, *http.Request)
	}{
		"me":                  {path: "/portal/me", fn: h.GetMe},
		"verification status": {path: "/portal/verification-status", fn: h.GetVerificationStatus},
		"resend verification": {path: "/portal/resend-verification", fn: h.ResendVerification},
	} {
		w := portalRequest(t, h, "missing", http.MethodGet, tc.path, `{}`, tc.fn)
		if w.Code != http.StatusInternalServerError {
			t.Errorf("%s status = %d", name, w.Code)
		}
	}
}

func TestPortalRegisterRejectsLongUsername(t *testing.T) {
	h := NewPortalHandler(database.OpenTestDB(t))
	body, _ := json.Marshal(map[string]string{
		"email": "long@example.com", "password": "long-enough",
		"username": strings.Repeat("a", 31),
	})
	req := httptest.NewRequest(http.MethodPost, "/portal/register", bytes.NewReader(body))
	w := httptest.NewRecorder()
	h.Register(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("long username status = %d", w.Code)
	}
}
