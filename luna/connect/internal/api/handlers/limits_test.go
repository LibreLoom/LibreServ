package handlers

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"golang.org/x/crypto/bcrypt"
)

func TestAllowGuessUsesDriverTransactions(t *testing.T) {
	d := testDeps(t)
	key := "email-check:203.0.113.10"
	if !allowGuess(d.DB, key, 3, 60) {
		t.Fatal("first guess should be allowed")
	}
	if !allowGuess(d.DB, key, 3, 60) {
		t.Fatal("second guess should be allowed")
	}
	if !allowGuess(d.DB, key, 3, 60) {
		t.Fatal("third guess should be allowed")
	}
	if allowGuess(d.DB, key, 3, 60) {
		t.Fatal("fourth guess should be blocked")
	}
}

func TestCheckEmailNotRateLimitedOnFirstTry(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	req := httptest.NewRequest(http.MethodPost, "/account/check-email", strings.NewReader(`{"email":"fresh@example.com"}`))
	req.RemoteAddr = "203.0.113.55:443"
	rec := httptest.NewRecorder()
	acct.CheckEmail(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("status=%d body=%s", rec.Code, rec.Body.String())
	}
	if strings.Contains(rec.Body.String(), "Too many tries") {
		t.Fatalf("unexpected rate limit: %s", rec.Body.String())
	}
}

// The per-IP bucket alone is reset by changing the client address. The account
// bucket must trip anyway, and a correct password must still get in and clear it.
func TestCustomerLoginAccountCapAcrossIPs(t *testing.T) {
	d := testDeps(t)
	acct := AccountHandler{Deps: d}
	const email = "cap@example.com"
	const password = "hunter22hunter1"

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	_, err = d.DB.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES (?, ?, ?, 0, 'none', 1, ?)`, "acct_cap", email, string(hash), time.Now().Unix())
	if err != nil {
		t.Fatal(err)
	}

	login := func(remoteAddr, password string) *httptest.ResponseRecorder {
		body := fmt.Sprintf(`{"email":%q,"password":%q}`, email, password)
		req := httptest.NewRequest(http.MethodPost, "/account/login", strings.NewReader(body))
		req.RemoteAddr = remoteAddr
		rec := httptest.NewRecorder()
		acct.Login(rec, req)
		return rec
	}

	// Each failure comes from a different address, so the IP+email bucket
	// never fills and only the per-account bucket can trip.
	for i := 0; i < signInAccountAttemptMax; i++ {
		rec := login(fmt.Sprintf("203.0.113.%d:1234", i+1), "wrong-password")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("failure %d: status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}

	rec := login("203.0.113.200:1234", "wrong-password")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("after %d failures status=%d body=%s", signInAccountAttemptMax, rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Too many tries") {
		t.Fatalf("expected the generic rate-limit answer, got %s", rec.Body.String())
	}

	// The owner is not locked out by guesses against their address.
	rec = login("203.0.113.201:1234", password)
	if rec.Code != http.StatusOK {
		t.Fatalf("correct password while capped: status=%d body=%s", rec.Code, rec.Body.String())
	}

	// A successful sign-in clears the bucket.
	rec = login("203.0.113.202:1234", "wrong-password")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("bucket should be clear after a successful sign-in: status=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestAdminLoginAccountCapAcrossIPs(t *testing.T) {
	d := testDeps(t)
	adm := AdminAuthHandler{Deps: d}
	const email = "staff@example.com"
	const password = "staff-password-1"

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.MinCost)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	_, err = d.DB.Exec(`INSERT INTO admin_accounts (id, email, password_hash, name, totp_enabled, is_active, created_at, updated_at)
VALUES (?, ?, ?, '', 0, 1, ?, ?)`, "admin_cap", email, string(hash), now, now)
	if err != nil {
		t.Fatal(err)
	}

	login := func(remoteAddr, password string) *httptest.ResponseRecorder {
		body := fmt.Sprintf(`{"email":%q,"password":%q}`, email, password)
		req := httptest.NewRequest(http.MethodPost, "/admin/login", strings.NewReader(body))
		req.RemoteAddr = remoteAddr
		rec := httptest.NewRecorder()
		adm.Login(rec, req)
		return rec
	}

	for i := 0; i < signInAccountAttemptMax; i++ {
		rec := login(fmt.Sprintf("203.0.114.%d:1234", i+1), "wrong-password")
		if rec.Code != http.StatusUnauthorized {
			t.Fatalf("failure %d: status=%d body=%s", i+1, rec.Code, rec.Body.String())
		}
	}

	rec := login("203.0.114.200:1234", "wrong-password")
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("after %d failures status=%d body=%s", signInAccountAttemptMax, rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "Too many sign-in tries") {
		t.Fatalf("expected the generic rate-limit answer, got %s", rec.Body.String())
	}

	// A correct password still signs the admin in and clears the bucket.
	rec = login("203.0.114.201:1234", password)
	if rec.Code != http.StatusOK {
		t.Fatalf("correct password while capped: status=%d body=%s", rec.Code, rec.Body.String())
	}
	rec = login("203.0.114.202:1234", "wrong-password")
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("bucket should be clear after a successful sign-in: status=%d body=%s", rec.Code, rec.Body.String())
	}
}
