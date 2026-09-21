package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// availabilityResp is the shape returned by GET /auth/mfa/availability.
type availabilityResp struct {
	TOTP        bool `json:"totp"`
	Email       bool `json:"email"`
	Passkey     bool `json:"passkey"`
	SecurityKey bool `json:"security_key"`
}

// TestAvailability_ReportsPerMethodCapabilities guards the contract the
// setup wizard's "choose a method" step relies on: it must hide methods the
// server can't service. The handler derives each flag from a distinct input:
//
//	totp        — the TOTP at-rest encryption key (SetMFATOTPEncryptionKey)
//	email       — an email-OTP sender wired AND the user has an email address
//	passkey/key — a WebAuthn verifier wired (WebAuthnAvailable)
//
// So a fresh handler with none of those reports all false; wiring each input
// turns its flag on independently.
func TestAvailability_ReportsPerMethodCapabilities(t *testing.T) {
	// Fresh handler: no TOTP key, no email sender (NewMFAHandler(.., nil)),
	// no WebAuthn verifier. The registered user has an email, but email is
	// still unavailable because the sender is nil.
	h, svc, userID := newTestMFAHandler(t, false)

	rr := httptest.NewRecorder()
	req := authedRequest(t, `{}`, userID, "alice")
	// Availability is a GET; authedRequest builds a POST — swap the method.
	req.Method = http.MethodGet
	req.URL.Path = "/api/v1/auth/mfa/availability"
	h.Availability(rr, req.WithContext(req.Context()))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	var resp availabilityResp
	decodeBody(t, rr, &resp)
	if resp.TOTP || resp.Email || resp.Passkey || resp.SecurityKey {
		t.Fatalf("fresh handler: availability = %+v, want all false (no key/sender/verifier)", resp)
	}

	// Wire the TOTP key → totp true only.
	svc.SetMFATOTPEncryptionKey("test-totp-encryption-key-32bytes!!")
	rr2 := httptest.NewRecorder()
	req2 := authedRequest(t, `{}`, userID, "alice")
	req2.Method = http.MethodGet
	h.Availability(rr2, req2.WithContext(req2.Context()))
	decodeBody(t, rr2, &resp)
	if !resp.TOTP {
		t.Error("after wiring TOTP key: totp = false, want true")
	}
	if resp.Email || resp.Passkey || resp.SecurityKey {
		t.Errorf("after wiring only TOTP key: email/passkey/security_key should stay false, got %+v", resp)
	}

	// Wire an email sender → email true (user has an email from newTestMFAHandler).
	h.SetEmailSender(func(email, code string) error { return nil })
	rr3 := httptest.NewRecorder()
	req3 := authedRequest(t, `{}`, userID, "alice")
	req3.Method = http.MethodGet
	h.Availability(rr3, req3.WithContext(req3.Context()))
	decodeBody(t, rr3, &resp)
	if !resp.Email {
		t.Error("after wiring email sender (user has email): email = false, want true")
	}
}

// TestAvailability_EmailRequiresAccountEmail ensures email is hidden when the
// caller's account has no address even if a sender is wired — codes can only
// be delivered to an address on file.
func TestAvailability_EmailRequiresAccountEmail(t *testing.T) {
	// Register a user with no email.
	h, svc, userID := newTestMFAHandler(t, false)
	// newTestMFAHandler's user ("alice") has an email; clear it directly.
	if u, err := svc.GetUserByID(context.Background(), userID); err == nil {
		u.Email = ""
		_ = svc.UpdateUser(context.Background(), u)
	}
	h.SetEmailSender(func(email, code string) error { return nil })

	rr := httptest.NewRecorder()
	req := authedRequest(t, `{}`, userID, "alice")
	req.Method = http.MethodGet
	h.Availability(rr, req.WithContext(req.Context()))
	var resp availabilityResp
	decodeBody(t, rr, &resp)
	if resp.Email {
		t.Error("email = true for an account with no email address, want false")
	}
}
