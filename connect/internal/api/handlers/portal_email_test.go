package handlers

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// newUnverifiedAccount inserts a customer account with an unverified email
// and returns its ID.
func newUnverifiedAccount(t *testing.T, db *sql.DB, email string) string {
	t.Helper()
	accountID := "acct-eml-" + security.RandomString(8)
	if _, err := db.Exec(
		`INSERT INTO customer_accounts (id, email, password_hash, plan_id, email_verified)
		 VALUES ($1, $2, 'hash', 'free', FALSE)`,
		accountID, email); err != nil {
		t.Fatalf("create account: %v", err)
	}
	return accountID
}

// updateEmailReq calls UpdateEmail with the given JSON body and returns the
// response status and decoded body.
func updateEmailReq(t *testing.T, db *sql.DB, accountID, body string) (int, map[string]any) {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/portal/account/email", bytes.NewReader([]byte(body)))
	req = req.WithContext(middleware.WithCustomerDeviceID(req.Context(), accountID))
	w := httptest.NewRecorder()
	NewPortalHandler(db).UpdateEmail(w, req)
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	return w.Code, resp
}

// accountEmail returns the current email stored on the account.
func accountEmail(t *testing.T, db *sql.DB, accountID string) string {
	t.Helper()
	var email string
	if err := db.QueryRow(
		`SELECT email FROM customer_accounts WHERE id = $1`, accountID,
	).Scan(&email); err != nil {
		t.Fatalf("query account email: %v", err)
	}
	return email
}

// seedEmailProvider inserts an enabled smtp provider and points the
// handler's Resend client at a mock API so verification emails "send".
func seedEmailProvider(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT INTO service_providers (id, service, name, credentials_json, settings_json, enabled)
		 VALUES ('prov-test-smtp', 'smtp', 'Resend', '{"api_key":"test-key"}', '{}', TRUE)`); err != nil {
		t.Fatalf("seed email provider: %v", err)
	}
}

// TestUpdateEmailChangesAddressAndReissuesToken is the core typo-fix flow:
// an unverified account can correct its address and gets a fresh verification
// token (old tokens are invalidated).
func TestUpdateEmailChangesAddressAndReissuesToken(t *testing.T) {
	db := database.OpenTestDB(t)
	seedEmailProvider(t, db)
	accountID := newUnverifiedAccount(t, db, "typo@example.com")

	resendMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(`{"id":"test-email-id"}`))
	}))
	defer resendMock.Close()

	h := NewPortalHandler(db)
	h.resend = providers.NewResendClientWithBaseURL(nil, resendMock.URL)

	req := httptest.NewRequest(http.MethodPost, "/portal/account/email",
		bytes.NewReader([]byte(`{"email":"fixed@example.com","source":"onboarding"}`)))
	req = req.WithContext(middleware.WithCustomerDeviceID(req.Context(), accountID))
	w := httptest.NewRecorder()
	h.UpdateEmail(w, req)
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	if w.Code != http.StatusOK {
		t.Fatalf("update email failed: %d %v", w.Code, resp)
	}
	if got := accountEmail(t, db, accountID); got != "fixed@example.com" {
		t.Fatalf("email = %q, want %q", got, "fixed@example.com")
	}

	// A fresh verification token must exist for the account.
	var n int
	if err := db.QueryRow(
		`SELECT count(*) FROM email_verification_tokens WHERE account_id = $1`, accountID,
	).Scan(&n); err != nil {
		t.Fatalf("count tokens: %v", err)
	}
	if n != 1 {
		t.Fatalf("verification tokens = %d, want 1", n)
	}
}

// TestUpdateEmailRejectsVerifiedAccounts — once verified, the address is
// locked; this endpoint must not become an account-takeover vector.
func TestUpdateEmailRejectsVerifiedAccounts(t *testing.T) {
	db := database.OpenTestDB(t)
	accountID := newVerifiedAccount(t, db)

	code, resp := updateEmailReq(t, db, accountID, `{"email":"other@example.com"}`)
	if code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (%v)", code, resp)
	}
	if got := accountEmail(t, db, accountID); got != accountID+"@test.com" {
		t.Fatalf("email changed for verified account: %q", got)
	}
}

// TestUpdateEmailRejectsDuplicate — cannot take an address another account
// already uses.
func TestUpdateEmailRejectsDuplicate(t *testing.T) {
	db := database.OpenTestDB(t)
	newUnverifiedAccount(t, db, "taken@example.com")
	victim := newUnverifiedAccount(t, db, "victim@example.com")

	code, resp := updateEmailReq(t, db, victim, `{"email":"taken@example.com"}`)
	if code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (%v)", code, resp)
	}
	if got := accountEmail(t, db, victim); got != "victim@example.com" {
		t.Fatalf("email changed despite conflict: %q", got)
	}
}

// TestUpdateEmailValidation — malformed and unchanged addresses are rejected.
func TestUpdateEmailValidation(t *testing.T) {
	db := database.OpenTestDB(t)
	accountID := newUnverifiedAccount(t, db, "current@example.com")

	for name, body := range map[string]string{
		"invalid format":    `{"email":"not-an-email"}`,
		"with display name": `{"email":"Name <display@example.com>"}`,
		"empty":             `{"email":""}`,
		"same address":      `{"email":"current@example.com"}`,
	} {
		code, resp := updateEmailReq(t, db, accountID, body)
		if code != http.StatusBadRequest {
			t.Fatalf("%s: status = %d, want 400 (%v)", name, code, resp)
		}
	}
}
