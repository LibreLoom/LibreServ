package handlers

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth/webauthn"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// newTestMFAHandler builds a real auth.Service (temp DB, fully migrated) with
// a test user + a wired webauthn.Verifier, and returns a ready MFAHandler.
// It exercises the true seam: handler -> auth.Service -> webauthn.Verifier
// (no mocks).
func newTestMFAHandler(t *testing.T, withVerifier bool) (*MFAHandler, *auth.Service, string) {
	t.Helper()
	dbPath := filepath.Join(t.TempDir(), "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	svc := auth.NewService(db, "test-jwt-secret-not-used-in-these-tests", slog.Default())
	user, err := svc.Register(context.Background(), &auth.RegisterRequest{
		Username: "alice",
		Password: "Password12345",
		Email:    "alice@example.com",
	})
	if err != nil {
		t.Fatalf("register user: %v", err)
	}
	if withVerifier {
		v, err := webauthn.New(webauthn.Config{
			RPID:          "example.org",
			RPDisplayName: "LibreServ",
			Origins:       []string{"https://example.org"},
		})
		if err != nil {
			t.Fatalf("new verifier: %v", err)
		}
		svc.SetWebAuthnVerifier(v)
	}
	return NewMFAHandler(svc, nil), svc, user.ID
}

// authedRequest builds a POST with the given JSON body and a context carrying
// the authenticated user (mirrors what the auth middleware sets).
func authedRequest(t *testing.T, body, userID, username string) *http.Request {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, "/api/v1/auth/mfa/webauthn/register/begin", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	user := &middleware.User{ID: userID, Username: username, Role: "user"}
	ctx := context.WithValue(r.Context(), middleware.UserContextKey, user)
	ctx = context.WithValue(ctx, middleware.UserIDContextKey, userID)
	return r.WithContext(ctx)
}

func decodeBody(t *testing.T, rr *httptest.ResponseRecorder, v any) {
	t.Helper()
	if err := json.Unmarshal(rr.Body.Bytes(), v); err != nil {
		t.Fatalf("decode response body %q: %v", rr.Body.String(), err)
	}
}

// TestWebAuthnRegisterBegin_Success verifies the begin response shape the
// frontend consumes: {"options": {"publicKey": {challenge, ...}}}, with the
// challenge as a non-empty base64url string at options.publicKey.challenge.
func TestWebAuthnRegisterBegin_Success(t *testing.T) {
	h, _, userID := newTestMFAHandler(t, true)
	rr := httptest.NewRecorder()
	body := `{"label":"My Passkey","type":"passkey"}`
	h.WebAuthnRegisterBegin(rr, authedRequest(t, body, userID, "alice"))

	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body=%s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Options struct {
			PublicKey struct {
				Challenge              string `json:"challenge"`
				AuthenticatorSelection struct {
					AuthenticatorAttachment string `json:"authenticatorAttachment"`
					ResidentKey             string `json:"residentKey"`
					UserVerification        string `json:"userVerification"`
				} `json:"authenticatorSelection"`
				RPID struct {
					ID string `json:"id"`
				} `json:"rp"`
			} `json:"publicKey"`
		} `json:"options"`
	}
	decodeBody(t, rr, &resp)
	if resp.Options.PublicKey.Challenge == "" {
		t.Fatalf("expected non-empty challenge at options.publicKey.challenge; body=%s", rr.Body.String())
	}
	if resp.Options.PublicKey.AuthenticatorSelection.AuthenticatorAttachment != "platform" {
		t.Errorf("authenticatorSelection.authenticatorAttachment = %q, want platform (passkey)", resp.Options.PublicKey.AuthenticatorSelection.AuthenticatorAttachment)
	}
	if resp.Options.PublicKey.AuthenticatorSelection.ResidentKey != "required" {
		t.Errorf("residentKey = %q, want required (passkey)", resp.Options.PublicKey.AuthenticatorSelection.ResidentKey)
	}
	if resp.Options.PublicKey.RPID.ID != "example.org" {
		t.Errorf("rp.id = %q, want example.org", resp.Options.PublicKey.RPID.ID)
	}
}

func TestWebAuthnRegisterBegin_BadType(t *testing.T) {
	h, _, userID := newTestMFAHandler(t, true)
	rr := httptest.NewRecorder()
	h.WebAuthnRegisterBegin(rr, authedRequest(t, `{"type":"fingerprint"}`, userID, "alice"))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", rr.Code)
	}
}

func TestWebAuthnRegisterBegin_Unauthenticated(t *testing.T) {
	h, _, _ := newTestMFAHandler(t, true)
	rr := httptest.NewRecorder()
	// No user in context.
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/mfa/webauthn/register/begin", strings.NewReader(`{"type":"passkey"}`))
	h.WebAuthnRegisterBegin(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
}

func TestWebAuthnRegisterBegin_VerifierUnavailable(t *testing.T) {
	h, _, userID := newTestMFAHandler(t, false) // no verifier wired
	rr := httptest.NewRecorder()
	h.WebAuthnRegisterBegin(rr, authedRequest(t, `{"type":"passkey"}`, userID, "alice"))
	if rr.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503 (verifier unavailable); body=%s", rr.Code, rr.Body.String())
	}
}

// TestWebAuthnRegisterFinish_MalformedCredential verifies a credential that
// fails verification maps to 400 (ErrInvalidAssertion), not 500/401.
func TestWebAuthnRegisterFinish_MalformedCredential(t *testing.T) {
	h, _, userID := newTestMFAHandler(t, true)
	// Seed a ceremony session first (begin), so finish has a pending session.
	beginRR := httptest.NewRecorder()
	h.WebAuthnRegisterBegin(beginRR, authedRequest(t, `{"type":"security_key"}`, userID, "alice"))
	if beginRR.Code != http.StatusOK {
		t.Fatalf("begin seed failed: %d %s", beginRR.Code, beginRR.Body.String())
	}

	// Malformed credential (invalid base64url) -> verifier rejects -> 400.
	malformed := `{"credential":{"id":"x","rawId":"x","type":"public-key","response":{"attestationObject":"!!!not-b64!!!","clientDataJSON":"!!!not-b64!!!"}}}`
	rr := httptest.NewRecorder()
	finishReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/mfa/webauthn/register/finish", strings.NewReader(malformed))
	finishReq.Header.Set("Content-Type", "application/json")
	user := &middleware.User{ID: userID, Username: "alice"}
	finishReq = finishReq.WithContext(context.WithValue(context.WithValue(finishReq.Context(), middleware.UserContextKey, user), middleware.UserIDContextKey, userID))
	h.WebAuthnRegisterFinish(rr, finishReq)

	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (invalid assertion); body=%s", rr.Code, rr.Body.String())
	}
}

func TestWebAuthnRegisterFinish_NoCredential(t *testing.T) {
	h, _, userID := newTestMFAHandler(t, true)
	rr := httptest.NewRecorder()
	finishReq := httptest.NewRequest(http.MethodPost, "/api/v1/auth/mfa/webauthn/register/finish", strings.NewReader(`{}`))
	finishReq.Header.Set("Content-Type", "application/json")
	user := &middleware.User{ID: userID, Username: "alice"}
	finishReq = finishReq.WithContext(context.WithValue(context.WithValue(finishReq.Context(), middleware.UserContextKey, user), middleware.UserIDContextKey, userID))
	h.WebAuthnRegisterFinish(rr, finishReq)
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (no credential)", rr.Code)
	}
}

func TestWebAuthnRegisterFinish_Unauthenticated(t *testing.T) {
	h, _, _ := newTestMFAHandler(t, true)
	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/v1/auth/mfa/webauthn/register/finish", strings.NewReader(`{"credential":{}}`))
	h.WebAuthnRegisterFinish(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rr.Code)
	}
}
