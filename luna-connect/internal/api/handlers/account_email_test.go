package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

func seedSMTPProvider(t *testing.T, h AccountHandler) {
	t.Helper()
	_, err := providers.NewService(h.DB).Create("smtp", "Resend",
		map[string]string{"api_key": "re_test"},
		map[string]string{"from_email": "Luna Connect <noreply@test.example>"},
		true)
	if err != nil {
		t.Fatalf("seed smtp: %v", err)
	}
}

func withMockResend(t *testing.T, h *AccountHandler) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"id":"email_test"}`))
	}))
	t.Cleanup(srv.Close)
	h.Resend = providers.NewResendClientWithBaseURL(nil, srv.URL)
	return srv
}

func TestRegisterCreatesVerificationToken(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	seedSMTPProvider(t, acct)
	withMockResend(t, &acct)

	cookie := registerUnverifiedAccount(t, acct, "new@example.com")
	if cookie == nil {
		t.Fatal("expected session cookie")
	}

	var verified int
	if err := acct.DB.QueryRow(`SELECT email_verified FROM accounts WHERE email = ?`, "new@example.com").Scan(&verified); err != nil {
		t.Fatal(err)
	}
	if verified != 0 {
		t.Fatalf("email_verified = %d, want 0", verified)
	}

	var n int
	if err := acct.DB.QueryRow(
		`SELECT count(*) FROM email_verification_tokens WHERE account_id = (SELECT id FROM accounts WHERE email = ?)`,
		"new@example.com",
	).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("tokens = %d, want 1", n)
	}
}

func TestVerifyEmailMarksVerified(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	seedSMTPProvider(t, acct)
	withMockResend(t, &acct)
	_ = registerUnverifiedAccount(t, acct, "v@example.com")

	var accountID, tokenHash string
	if err := acct.DB.QueryRow(
		`SELECT a.id, t.token_hash FROM accounts a
		 JOIN email_verification_tokens t ON t.account_id = a.id
		 WHERE a.email = ?`, "v@example.com",
	).Scan(&accountID, &tokenHash); err != nil {
		t.Fatal(err)
	}

	// Reconstruct is impossible from hash — mint a known token for verify.
	raw := "known-verify-token"
	_, _ = acct.DB.Exec(`DELETE FROM email_verification_tokens WHERE account_id = ?`, accountID)
	tok, err := acct.createEmailVerificationToken(t.Context(), accountID)
	if err != nil {
		t.Fatal(err)
	}
	_ = raw
	_ = tokenHash

	req := httptest.NewRequest(http.MethodPost, "/account/verify-email",
		bytes.NewBufferString(`{"token":"`+tok+`"}`))
	rec := httptest.NewRecorder()
	acct.VerifyEmail(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("verify %d %s", rec.Code, rec.Body.String())
	}

	var verified int
	_ = acct.DB.QueryRow(`SELECT email_verified FROM accounts WHERE id = ?`, accountID).Scan(&verified)
	if verified != 1 {
		t.Fatalf("email_verified = %d, want 1", verified)
	}
}

func TestProductRouteForbiddenUntilVerified(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	cookie := registerUnverifiedAccount(t, acct, "gate@example.com")

	req := httptest.NewRequest(http.MethodGet, "/account/devices", nil)
	req.AddCookie(cookie)
	rec := httptest.NewRecorder()
	acct.AccountAuth(acct.RequireVerifiedEmail(http.HandlerFunc(acct.Devices))).ServeHTTP(rec, req)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 (%s)", rec.Code, rec.Body.String())
	}

	_, _ = acct.DB.Exec(`UPDATE accounts SET email_verified = 1 WHERE email = ?`, "gate@example.com")
	req2 := httptest.NewRequest(http.MethodGet, "/account/devices", nil)
	req2.AddCookie(cookie)
	rec2 := httptest.NewRecorder()
	acct.AccountAuth(acct.RequireVerifiedEmail(http.HandlerFunc(acct.Devices))).ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("after verify status = %d %s", rec2.Code, rec2.Body.String())
	}
}

func TestUpdateEmailChangesAddressAndReissuesToken(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	seedSMTPProvider(t, acct)
	withMockResend(t, &acct)
	cookie := registerUnverifiedAccount(t, acct, "typo@example.com")

	req := httptest.NewRequest(http.MethodPost, "/account/email",
		bytes.NewBufferString(`{"email":"fixed@example.com","source":"onboarding"}`))
	req.AddCookie(cookie)
	rec := withAccount(acct, acct.UpdateEmail, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("update email %d %s", rec.Code, rec.Body.String())
	}

	var email string
	_ = acct.DB.QueryRow(`SELECT email FROM accounts WHERE email = ? OR email = ?`,
		"fixed@example.com", "typo@example.com").Scan(&email)
	if email != "fixed@example.com" {
		t.Fatalf("email = %q, want fixed@example.com", email)
	}

	var n int
	_ = acct.DB.QueryRow(
		`SELECT count(*) FROM email_verification_tokens WHERE account_id = (SELECT id FROM accounts WHERE email = ?)`,
		"fixed@example.com",
	).Scan(&n)
	if n != 1 {
		t.Fatalf("tokens = %d, want 1", n)
	}
}

func TestUpdateEmailRejectsVerifiedAccounts(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	cookie := registerAccount(t, acct, "locked@example.com")

	req := httptest.NewRequest(http.MethodPost, "/account/email",
		bytes.NewBufferString(`{"email":"other@example.com"}`))
	req.AddCookie(cookie)
	rec := withAccount(acct, acct.UpdateEmail, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%s)", rec.Code, rec.Body.String())
	}
}

func TestUpdateEmailRejectsDuplicate(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	_ = registerUnverifiedAccount(t, acct, "taken@example.com")
	cookie := registerUnverifiedAccount(t, acct, "victim@example.com")

	req := httptest.NewRequest(http.MethodPost, "/account/email",
		bytes.NewBufferString(`{"email":"taken@example.com"}`))
	req.AddCookie(cookie)
	rec := withAccount(acct, acct.UpdateEmail, req)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%s)", rec.Code, rec.Body.String())
	}
}

func TestMeReturnsEmailVerified(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	cookie := registerUnverifiedAccount(t, acct, "me@example.com")

	req := httptest.NewRequest(http.MethodGet, "/account/me", nil)
	req.AddCookie(cookie)
	rec := withAccount(acct, acct.Me, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("me %d %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["email_verified"] != false {
		t.Fatalf("email_verified = %v, want false", out["email_verified"])
	}

	_, _ = acct.DB.Exec(`UPDATE accounts SET email_verified = 1 WHERE email = ?`, "me@example.com")
	req2 := httptest.NewRequest(http.MethodGet, "/account/me", nil)
	req2.AddCookie(cookie)
	rec2 := withAccount(acct, acct.Me, req2)
	_ = json.Unmarshal(rec2.Body.Bytes(), &out)
	if out["email_verified"] != true {
		t.Fatalf("email_verified = %v, want true", out["email_verified"])
	}
}

func TestVerificationStatusUngated(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	cookie := registerUnverifiedAccount(t, acct, "status@example.com")

	req := httptest.NewRequest(http.MethodGet, "/account/verification-status", nil)
	req.AddCookie(cookie)
	rec := withAccount(acct, acct.GetVerificationStatus, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d %s", rec.Code, rec.Body.String())
	}
	var out map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &out)
	if out["email_verified"] != false {
		t.Fatalf("got %v", out)
	}
}
