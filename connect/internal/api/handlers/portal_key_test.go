package handlers

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// regenKey calls GenerateConnectKey with the given JSON body and returns the
// response status and decoded body.
func regenKey(t *testing.T, db *sql.DB, accountID string, body string) (int, map[string]any) {
	t.Helper()
	var reader *bytes.Reader
	if body == "" {
		reader = bytes.NewReader([]byte("{}"))
	} else {
		reader = bytes.NewReader([]byte(body))
	}
	req := httptest.NewRequest(http.MethodPost, "/portal/connect-keys", reader)
	req = req.WithContext(middleware.WithCustomerDeviceID(req.Context(), accountID))
	w := httptest.NewRecorder()
	NewPortalHandler(db).GenerateConnectKey(w, req)
	var resp map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &resp)
	return w.Code, resp
}

// currentKeySubdomain returns the subdomain stamped on the account's current
// (only) Connect key.
func currentKeySubdomain(t *testing.T, db *sql.DB, accountID string) string {
	t.Helper()
	var sub sql.NullString
	if err := db.QueryRow(
		`SELECT subdomain FROM connect_keys WHERE account_id = $1`, accountID,
	).Scan(&sub); err != nil {
		t.Fatalf("query current key: %v", err)
	}
	if !sub.Valid {
		return ""
	}
	return sub.String
}

// newVerifiedAccount inserts a customer account with a verified email.
func newVerifiedAccount(t *testing.T, db *sql.DB) string {
	t.Helper()
	accountID := "acc-key-" + security.RandomString(8)
	if _, err := db.Exec(
		`INSERT INTO customer_accounts (id, email, password_hash, plan_id, email_verified)
		 VALUES ($1, $2, 'hash', 'free', TRUE)`,
		accountID, accountID+"@test.com"); err != nil {
		t.Fatalf("create account: %v", err)
	}
	return accountID
}

// insertStampedKey inserts an unused Connect key carrying the given subdomain
// and returns the plaintext key.
func insertStampedKey(t *testing.T, db *sql.DB, accountID, sub string) string {
	t.Helper()
	key := security.GenerateConnectKey()
	if _, err := db.Exec(
		`INSERT INTO connect_keys (id, key_hash, key_prefix, account_id, plan_id, subdomain, status)
		 VALUES ($1, $2, $3, $4, 'free', $5, 'unused')`,
		security.GenerateID("lic"), hashToken(key), key[:8], accountID,
		sql.NullString{String: sub, Valid: sub != ""}); err != nil {
		t.Fatalf("create Connect key: %v", err)
	}
	return key
}

// TestGenerateConnectKeyRegeneratePreservesDeviceSubdomain is the core
// guarantee: regenerating a key with NO explicit subdomain must carry the
// device's current subdomain over to the fresh key, so the user's domain name
// never changes.
func TestGenerateConnectKeyRegeneratePreservesDeviceSubdomain(t *testing.T) {
	db := database.OpenTestDB(t)
	accountID := newVerifiedAccount(t, db)

	// Activate a device with a key stamped with the user's chosen subdomain.
	key := insertStampedKey(t, db, accountID, "mypick")
	body, _ := json.Marshal(map[string]string{"connect_key": key})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/activate", bytes.NewReader(body))
	w := httptest.NewRecorder()
	NewDeviceHandler(db).Activate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("activate failed: %d %s", w.Code, w.Body.String())
	}

	// Regenerate with an empty body — the dashboard's "Regenerate" action.
	code, resp := regenKey(t, db, accountID, "")
	if code != http.StatusOK {
		t.Fatalf("regenerate failed: %d %v", code, resp)
	}

	if got := currentKeySubdomain(t, db, accountID); got != "mypick" {
		t.Fatalf("regenerated key subdomain = %q, want %q (domain must not change)", got, "mypick")
	}

	// The old device must be deactivated (regeneration semantics) but its
	// subdomain must have survived onto the new key.
	var active bool
	if err := db.QueryRow(
		`SELECT is_active FROM devices WHERE account_id = $1`, accountID,
	).Scan(&active); err != nil {
		t.Fatalf("query device: %v", err)
	}
	if active {
		t.Fatal("expected device to be deactivated after regeneration")
	}
}

// TestGenerateConnectKeyRegeneratePreservesStampedSubdomain covers an unused
// key (never activated): the subdomain stamped at creation must survive.
func TestGenerateConnectKeyRegeneratePreservesStampedSubdomain(t *testing.T) {
	db := database.OpenTestDB(t)
	accountID := newVerifiedAccount(t, db)
	insertStampedKey(t, db, accountID, "mypick")

	code, resp := regenKey(t, db, accountID, "")
	if code != http.StatusOK {
		t.Fatalf("regenerate failed: %d %v", code, resp)
	}

	if got := currentKeySubdomain(t, db, accountID); got != "mypick" {
		t.Fatalf("regenerated key subdomain = %q, want %q", got, "mypick")
	}
}

// TestGenerateConnectKeyRegeneratePreservesDerivedSubdomain covers a device
// activated with no user-chosen subdomain: the portal derives a subdomain from
// the device ID, and regeneration must preserve that derived name rather than
// minting a new random one.
func TestGenerateConnectKeyRegeneratePreservesDerivedSubdomain(t *testing.T) {
	db := database.OpenTestDB(t)
	accountID := newVerifiedAccount(t, db)

	// Activate with a key that has NO stamped subdomain.
	key := insertStampedKey(t, db, accountID, "")
	body, _ := json.Marshal(map[string]string{"connect_key": key})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/activate", bytes.NewReader(body))
	w := httptest.NewRecorder()
	NewDeviceHandler(db).Activate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("activate failed: %d %s", w.Code, w.Body.String())
	}

	var deviceID string
	if err := db.QueryRow(
		`SELECT id FROM devices WHERE account_id = $1`, accountID,
	).Scan(&deviceID); err != nil {
		t.Fatalf("query device: %v", err)
	}
	want := deviceID
	if len(want) >= 8 {
		want = want[len(want)-8:]
	}

	code, resp := regenKey(t, db, accountID, "")
	if code != http.StatusOK {
		t.Fatalf("regenerate failed: %d %v", code, resp)
	}

	if got := currentKeySubdomain(t, db, accountID); got != want {
		t.Fatalf("regenerated key subdomain = %q, want derived %q", got, want)
	}
}

// TestGenerateConnectKeyExplicitSubdomainStillHonored verifies that an
// explicit subdomain in the request still wins (the deliberate-change path).
func TestGenerateConnectKeyExplicitSubdomainStillHonored(t *testing.T) {
	db := database.OpenTestDB(t)
	accountID := newVerifiedAccount(t, db)
	insertStampedKey(t, db, accountID, "oldpick")

	code, resp := regenKey(t, db, accountID, `{"subdomain":"newpick"}`)
	if code != http.StatusOK {
		t.Fatalf("regenerate failed: %d %v", code, resp)
	}

	if got := currentKeySubdomain(t, db, accountID); got != "newpick" {
		t.Fatalf("regenerated key subdomain = %q, want %q", got, "newpick")
	}
}

// TestGenerateConnectKeyPreservingOwnSubdomainNotRejected ensures the
// availability check does not reject the account's own current subdomain
// (which previously made regeneration with a preserved domain 409).
func TestGenerateConnectKeyPreservingOwnSubdomainNotRejected(t *testing.T) {
	db := database.OpenTestDB(t)
	accountID := newVerifiedAccount(t, db)

	// An active device holding the subdomain.
	key := insertStampedKey(t, db, accountID, "mypick")
	body, _ := json.Marshal(map[string]string{"connect_key": key})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/activate", bytes.NewReader(body))
	w := httptest.NewRecorder()
	NewDeviceHandler(db).Activate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("activate failed: %d %s", w.Code, w.Body.String())
	}

	// Explicitly re-picking the same subdomain the account already owns must
	// not be rejected as "taken".
	code, resp := regenKey(t, db, accountID, `{"subdomain":"mypick"}`)
	if code != http.StatusOK {
		t.Fatalf("re-picking own subdomain failed: %d %v", code, resp)
	}
	if got := currentKeySubdomain(t, db, accountID); got != "mypick" {
		t.Fatalf("regenerated key subdomain = %q, want %q", got, "mypick")
	}
}

// TestRegenerateThenReactivatePreservesUsageAndCredits is the core "no usage
// reset" guarantee: after regenerating the key and re-activating the device,
// the device row is REUSED (same id), so usage history and the prepaid credit
// balance survive. Deleting the row instead would cascade-delete everything
// keyed by device_id (usage_events, account_credits, invoices, …).
func TestRegenerateThenReactivatePreservesUsageAndCredits(t *testing.T) {
	db := database.OpenTestDB(t)
	accountID := newVerifiedAccount(t, db)

	key := insertStampedKey(t, db, accountID, "mypick")
	body, _ := json.Marshal(map[string]string{"connect_key": key})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/activate", bytes.NewReader(body))
	w := httptest.NewRecorder()
	NewDeviceHandler(db).Activate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("activate failed: %d %s", w.Code, w.Body.String())
	}

	var deviceID string
	if err := db.QueryRow(`SELECT id FROM devices WHERE account_id = $1`, accountID).Scan(&deviceID); err != nil {
		t.Fatalf("query device: %v", err)
	}

	// Seed usage history + a prepaid credit balance. (The first activation
	// already created a zero-balance credit row via EnsureAccountCredits, so
	// top it up rather than inserting a duplicate.)
	if _, err := db.Exec(
		`INSERT INTO usage_events (device_id, plan_id, service_type, metric, value, cost_usd, credits_consumed, timestamp)
		 VALUES ($1, 'free', 'domain', 'queries', 42, 0.01, 5, CURRENT_TIMESTAMP)`, deviceID); err != nil {
		t.Fatalf("seed usage: %v", err)
	}
	if _, err := db.Exec(
		`UPDATE account_credits SET balance_cents = 1250 WHERE device_id = $1`, deviceID); err != nil {
		t.Fatalf("seed credits: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO custom_domains (id, device_id, domain, registered_via, auto_renew, status, expires_at)
		 VALUES ($1, $2, 'mydomain.com', 'cloudflare', TRUE, 'active', $3)`,
		"dom-kep", deviceID, time.Now().AddDate(1, 0, 0)); err != nil {
		t.Fatalf("seed custom domain: %v", err)
	}

	// Regenerate the key (deactivates the device), then re-activate with it.
	code, resp := regenKey(t, db, accountID, "")
	if code != http.StatusOK {
		t.Fatalf("regenerate failed: %d %v", code, resp)
	}
	newKey, _ := resp["connect_key"].(string)
	if newKey == "" {
		t.Fatal("regenerate response missing connect_key")
	}

	body2, _ := json.Marshal(map[string]string{"connect_key": newKey})
	req2 := httptest.NewRequest(http.MethodPost, "/api/v1/activate", bytes.NewReader(body2))
	w2 := httptest.NewRecorder()
	NewDeviceHandler(db).Activate(w2, req2)
	if w2.Code != http.StatusOK {
		t.Fatalf("re-activate failed: %d %s", w2.Code, w2.Body.String())
	}

	// The device row must keep its id — otherwise usage/billing are reset.
	var reactivatedID string
	if err := db.QueryRow(
		`SELECT id FROM devices WHERE account_id = $1 AND is_active = TRUE`, accountID,
	).Scan(&reactivatedID); err != nil {
		t.Fatalf("query re-activated device: %v", err)
	}
	if reactivatedID != deviceID {
		t.Fatalf("device id changed after regeneration: %q -> %q (usage would be reset)", deviceID, reactivatedID)
	}

	var events int
	if err := db.QueryRow(`SELECT COUNT(*) FROM usage_events WHERE device_id = $1`, deviceID).Scan(&events); err != nil {
		t.Fatalf("count usage events: %v", err)
	}
	if events != 1 {
		t.Fatalf("usage events after re-activation = %d, want 1", events)
	}

	var balance int
	if err := db.QueryRow(`SELECT balance_cents FROM account_credits WHERE device_id = $1`, deviceID).Scan(&balance); err != nil {
		t.Fatalf("query credit balance: %v", err)
	}
	if balance != 1250 {
		t.Fatalf("credit balance after re-activation = %d, want 1250", balance)
	}

	// Registered custom domains must survive too (they cascade with device_id).
	var domStatus string
	if err := db.QueryRow(
		`SELECT status FROM custom_domains WHERE domain = 'mydomain.com' AND device_id = $1`, deviceID,
	).Scan(&domStatus); err != nil {
		t.Fatalf("custom domain lost after re-activation: %v", err)
	}
	if domStatus != "active" {
		t.Fatalf("custom domain status = %q, want active", domStatus)
	}
}

// TestGenerateConnectKeyOtherAccountsSubdomainStillRejected verifies the
// availability check still rejects a subdomain claimed by ANOTHER account —
// preservation excludes only the caller's own rows.
func TestGenerateConnectKeyOtherAccountsSubdomainStillRejected(t *testing.T) {
	db := database.OpenTestDB(t)
	accountID := newVerifiedAccount(t, db)

	// Another account's active device already holds "mypick".
	other := newVerifiedAccount(t, db)
	key := insertStampedKey(t, db, other, "mypick")
	body, _ := json.Marshal(map[string]string{"connect_key": key})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/activate", bytes.NewReader(body))
	w := httptest.NewRecorder()
	NewDeviceHandler(db).Activate(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("other account activate failed: %d %s", w.Code, w.Body.String())
	}

	// accountID tries to claim the same subdomain → must be rejected.
	code, resp := regenKey(t, db, accountID, `{"subdomain":"mypick"}`)
	if code != http.StatusConflict {
		t.Fatalf("cross-account claim: expected 409, got %d %v", code, resp)
	}
}
