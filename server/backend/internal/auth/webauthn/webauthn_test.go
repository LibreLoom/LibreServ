package webauthn

import (
	"bytes"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"testing"

	"github.com/google/uuid"

	"github.com/go-webauthn/webauthn/protocol/webauthncbor"
	wapi "github.com/go-webauthn/webauthn/webauthn"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
)

// newTestVerifier builds a Verifier against a fixed test Relying Party.
func newTestVerifier(t *testing.T) *Verifier {
	t.Helper()
	v, err := New(Config{
		RPID:          "example.org",
		RPDisplayName: "LibreServ",
		Origins:       []string{"https://example.org"},
	})
	if err != nil {
		t.Fatalf("New verifier: %v", err)
	}
	return v
}

// virtualAuthenticator is a minimal software authenticator that produces valid
// navigator.credentials.create/get responses for the ES256 ("none" attestation)
// flow. It exists only so the ceremony round-trip can be exercised end-to-end
// without a browser. backupEligible is the BE flag the authenticator reports;
// it must stay consistent between registration and login (the library enforces
// this), which mirrors a real device.
type virtualAuthenticator struct {
	priv           *ecdsa.PrivateKey
	credID         []byte
	aaguid         []byte // 16 bytes
	counter        uint32
	backupEligible bool
	attachment     string // "platform" | "cross-platform"
}

func newVirtualAuthenticator(t *testing.T, backupEligible bool, attachment string) *virtualAuthenticator {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	credID := make([]byte, 32)
	if _, err := rand.Read(credID); err != nil {
		t.Fatalf("rand credID: %v", err)
	}
	a := uuid.New() // [16]byte
	return &virtualAuthenticator{
		priv:           priv,
		credID:         credID,
		aaguid:         a[:],
		counter:        0,
		backupEligible: backupEligible,
		attachment:     attachment,
	}
}

// cosePublicKey encodes the authenticator's public key as a COSE_Key
// (EC2/ES256/P-256). The map[int]any form produces the int-keyed CBOR the
// library expects to unmarshal into webauthncose.EC2PublicKeyData.
func (a *virtualAuthenticator) cosePublicKey() []byte {
	key := map[int]any{
		1:  int64(2),  // kty: EC2
		3:  int64(-7), // alg: ES256
		-1: int64(1),  // crv: P-256
		-2: pad32(a.priv.PublicKey.X.Bytes()),
		-3: pad32(a.priv.PublicKey.Y.Bytes()),
	}
	out, err := webauthncbor.Marshal(key)
	if err != nil {
		panic("marshal cose key: " + err.Error())
	}
	return out
}

// createCredential returns the navigator.credentials.create response JSON for a
// registration challenge (base64url-no-padding string).
func (a *virtualAuthenticator) createCredential(challengeB64, rpID, origin string) json.RawMessage {
	rpIDHash := sha256.Sum256([]byte(rpID))
	flags := byte(0x01 | 0x04 | 0x40) // UP | UV | AT (attested credential data)
	if a.backupEligible {
		flags |= 0x08 // BE
	}
	counter := make([]byte, 4) // registration counter is 0

	pub := a.cosePublicKey()
	credIDLen := make([]byte, 2)
	binary.BigEndian.PutUint16(credIDLen, uint16(len(a.credID)))

	// authData = rpIDHash(32) + flags(1) + signCount(4) + attData(aaguid + len + credID + pubKey)
	authData := make([]byte, 0, 37+16+2+len(a.credID)+len(pub))
	authData = append(authData, rpIDHash[:]...)
	authData = append(authData, flags)
	authData = append(authData, counter...)
	authData = append(authData, a.aaguid...)
	authData = append(authData, credIDLen...)
	authData = append(authData, a.credID...)
	authData = append(authData, pub...)

	attObj, err := webauthncbor.Marshal(map[string]any{
		"fmt":      "none",
		"authData": authData,
		"attStmt":  map[string]any{},
	})
	if err != nil {
		panic("marshal attestation object: " + err.Error())
	}

	cdj, _ := json.Marshal(map[string]any{
		"type":      "webauthn.create",
		"challenge": challengeB64,
		"origin":    origin,
	})

	idB64 := base64.RawURLEncoding.EncodeToString(a.credID)
	resp, _ := json.Marshal(map[string]any{
		"id":    idB64,
		"rawId": idB64,
		"type":  "public-key",
		"response": map[string]any{
			"attestationObject": base64.RawURLEncoding.EncodeToString(attObj),
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(cdj),
		},
		"authenticatorAttachment": a.attachment,
	})
	return resp
}

// createAssertion returns the navigator.credentials.get response JSON for a login
// challenge (base64url-no-padding string). The signature covers
// authData || SHA256(clientDataJSON).
func (a *virtualAuthenticator) createAssertion(challengeB64, rpID, origin string) json.RawMessage {
	rpIDHash := sha256.Sum256([]byte(rpID))
	flags := byte(0x01 | 0x04) // UP | UV (no AT for assertions)
	if a.backupEligible {
		flags |= 0x08 // BE — must match the stored credential
	}
	a.counter++
	counter := make([]byte, 4)
	binary.BigEndian.PutUint32(counter, a.counter)

	authData := make([]byte, 0, 37)
	authData = append(authData, rpIDHash[:]...)
	authData = append(authData, flags)
	authData = append(authData, counter...)

	cdj, _ := json.Marshal(map[string]any{
		"type":      "webauthn.get",
		"challenge": challengeB64,
		"origin":    origin,
	})
	cdjHash := sha256.Sum256(cdj)
	signed := append(append([]byte{}, authData...), cdjHash[:]...)
	digest := sha256.Sum256(signed)
	sig, err := ecdsa.SignASN1(rand.Reader, a.priv, digest[:])
	if err != nil {
		panic("sign assertion: " + err.Error())
	}

	idB64 := base64.RawURLEncoding.EncodeToString(a.credID)
	resp, _ := json.Marshal(map[string]any{
		"id":    idB64,
		"rawId": idB64,
		"type":  "public-key",
		"response": map[string]any{
			"authenticatorData": base64.RawURLEncoding.EncodeToString(authData),
			"clientDataJSON":    base64.RawURLEncoding.EncodeToString(cdj),
			"signature":         base64.RawURLEncoding.EncodeToString(sig),
		},
	})
	return resp
}

func pad32(b []byte) []byte {
	if len(b) >= 32 {
		return b[len(b)-32:]
	}
	out := make([]byte, 32)
	copy(out[32-len(b):], b)
	return out
}

// extractChallenge unmarshals a begin-response JSON blob and returns the
// challenge as the base64url-no-padding string the client must echo back.
func extractChallenge(t *testing.T, begin json.RawMessage) string {
	t.Helper()
	// Both CredentialCreation and CredentialAssertion nest options under "publicKey".
	var wrap struct {
		PublicKey struct {
			Challenge string `json:"challenge"`
		} `json:"publicKey"`
	}
	if err := json.Unmarshal(begin, &wrap); err != nil {
		t.Fatalf("unmarshal begin response: %v", err)
	}
	if wrap.PublicKey.Challenge == "" {
		t.Fatal("begin response had empty challenge")
	}
	return wrap.PublicKey.Challenge
}

// TestVerifier_RegisterAndLoginRoundTrip exercises the full ceremony for both
// attachment types: enroll a credential, then log in with it. Passkeys report
// backup-eligibility (BE=1); security keys do not (BE=0) — this proves the
// stored Record carries BE through the library's login consistency check.
func TestVerifier_RegisterAndLoginRoundTrip(t *testing.T) {
	ctx := context.Background()
	v := newTestVerifier(t)

	cases := []struct {
		name      string
		att       auth.WebAuthnAttachment
		mfaType   string
		backup    bool
		attachStr string
	}{
		{"passkey", auth.WebAuthnPlatform, "passkey", true, "platform"},
		{"security_key", auth.WebAuthnCrossPlatform, "security_key", false, "cross-platform"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			authn := newVirtualAuthenticator(t, tc.backup, tc.attachStr)
			userID := uuid.NewString()

			// --- Enrollment ---
			creation, err := v.BeginRegistration(ctx, userID, "alice", "Alice", tc.att)
			if err != nil {
				t.Fatalf("BeginRegistration: %v", err)
			}
			challenge := extractChallenge(t, creation)
			credResp := authn.createCredential(challenge, "example.org", "https://example.org")

			cred, err := v.FinishRegistration(ctx, userID, credResp)
			if err != nil {
				t.Fatalf("FinishRegistration: %v", err)
			}
			if len(cred.CredentialID) == 0 {
				t.Fatal("FinishRegistration returned empty credential id")
			}
			if len(cred.Record) == 0 {
				t.Fatal("FinishRegistration returned empty record")
			}
			// Simulate the auth service assigning the mfa_methods row id.
			cred.MethodID = "method-" + tc.name

			// Sanity: the stored record carries the backup-eligibility flag.
			var stored wapi.Credential
			if err := json.Unmarshal(cred.Record, &stored); err != nil {
				t.Fatalf("unmarshal stored record: %v", err)
			}
			if stored.Flags.BackupEligible != tc.backup {
				t.Fatalf("stored BackupEligible=%v, want %v", stored.Flags.BackupEligible, tc.backup)
			}

			// --- Login ---
			assertionOpts, err := v.BeginLogin(ctx, userID, tc.mfaType, []auth.WebAuthnCredential{cred})
			if err != nil {
				t.Fatalf("BeginLogin: %v", err)
			}
			loginChallenge := extractChallenge(t, assertionOpts)
			assertResp := authn.createAssertion(loginChallenge, "example.org", "https://example.org")

			matchedMethodID, updatedRecord, err := v.VerifyLogin(ctx, userID, tc.mfaType, []auth.WebAuthnCredential{cred}, assertResp)
			if err != nil {
				t.Fatalf("VerifyLogin: %v", err)
			}
			if matchedMethodID != "method-"+tc.name {
				t.Fatalf("matched method id = %q, want %q", matchedMethodID, "method-"+tc.name)
			}
			if len(updatedRecord) == 0 {
				t.Fatal("VerifyLogin returned empty updated record")
			}

			// The updated record carries the incremented sign counter.
			var updated wapi.Credential
			if err := json.Unmarshal(updatedRecord, &updated); err != nil {
				t.Fatalf("unmarshal updated record: %v", err)
			}
			if updated.Authenticator.SignCount != 1 {
				t.Fatalf("updated sign count = %d, want 1", updated.Authenticator.SignCount)
			}
		})
	}
}

// TestVerifier_RejectsTamperedAssertion verifies a bad signature yields
// ErrInvalidAssertion (mapped to 401 by the service).
func TestVerifier_RejectsTamperedAssertion(t *testing.T) {
	ctx := context.Background()
	v := newTestVerifier(t)
	authn := newVirtualAuthenticator(t, false, "cross-platform")
	userID := uuid.NewString()

	creation, err := v.BeginRegistration(ctx, userID, "bob", "Bob", auth.WebAuthnCrossPlatform)
	if err != nil {
		t.Fatalf("BeginRegistration: %v", err)
	}
	challenge := extractChallenge(t, creation)
	cred, err := v.FinishRegistration(ctx, userID, authn.createCredential(challenge, "example.org", "https://example.org"))
	if err != nil {
		t.Fatalf("FinishRegistration: %v", err)
	}
	cred.MethodID = "m1"

	assertionOpts, err := v.BeginLogin(ctx, userID, "security_key", []auth.WebAuthnCredential{cred})
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	loginChallenge := extractChallenge(t, assertionOpts)
	assertResp := authn.createAssertion(loginChallenge, "example.org", "https://example.org")

	// Corrupt the signature field so verification fails.
	var parsed map[string]any
	if err := json.Unmarshal(assertResp, &parsed); err != nil {
		t.Fatalf("unmarshal assertion: %v", err)
	}
	resp := parsed["response"].(map[string]any)
	badSig := "AAAA" + resp["signature"].(string)[4:]
	resp["signature"] = badSig
	tampered, _ := json.Marshal(parsed)

	_, _, err = v.VerifyLogin(ctx, userID, "security_key", []auth.WebAuthnCredential{cred}, tampered)
	if !errors.Is(err, ErrInvalidAssertion) {
		t.Fatalf("VerifyLogin with tampered signature: err=%v, want ErrInvalidAssertion", err)
	}
}

// TestVerifier_SessionExpired verifies VerifyLogin without a preceding BeginLogin
// returns ErrSessionExpired (mapped to 400 — re-challenge).
func TestVerifier_SessionExpired(t *testing.T) {
	ctx := context.Background()
	v := newTestVerifier(t)
	authn := newVirtualAuthenticator(t, true, "platform")
	userID := uuid.NewString()

	// Register so we have a valid credential + a plausible assertion to send.
	creation, err := v.BeginRegistration(ctx, userID, "carol", "Carol", auth.WebAuthnPlatform)
	if err != nil {
		t.Fatalf("BeginRegistration: %v", err)
	}
	challenge := extractChallenge(t, creation)
	cred, err := v.FinishRegistration(ctx, userID, authn.createCredential(challenge, "example.org", "https://example.org"))
	if err != nil {
		t.Fatalf("FinishRegistration: %v", err)
	}
	cred.MethodID = "m1"

	// No BeginLogin call -> no login session for this user.
	assertResp := authn.createAssertion("cGxhY2Vob2xkZXItY2hhbGxlbmdl", "example.org", "https://example.org")
	_, _, err = v.VerifyLogin(ctx, userID, "passkey", []auth.WebAuthnCredential{cred}, assertResp)
	if !errors.Is(err, ErrSessionExpired) {
		t.Fatalf("VerifyLogin with no session: err=%v, want ErrSessionExpired", err)
	}
}

// TestVerifier_NoCredentials verifies BeginLogin with zero stored credentials
// returns ErrNoCredentials (mapped to 400).
func TestVerifier_NoCredentials(t *testing.T) {
	ctx := context.Background()
	v := newTestVerifier(t)
	_, err := v.BeginLogin(ctx, uuid.NewString(), "passkey", nil)
	if !errors.Is(err, ErrNoCredentials) {
		t.Fatalf("BeginLogin with no creds: err=%v, want ErrNoCredentials", err)
	}
}

// TestVerifier_VerifyLogin_MatchesCorrectCredential enrolls TWO credentials
// (distinct authenticators) and verifies that VerifyLogin returns the MethodID of
// the one that actually signed (not the first). This is the property the auth
// service relies on to persist the updated record on the right mfa_methods row.
func TestVerifier_VerifyLogin_MatchesCorrectCredential(t *testing.T) {
	ctx := context.Background()
	v := newTestVerifier(t)
	userID := uuid.NewString()

	enroll := func(methodID string, backup bool, attach string) (auth.WebAuthnCredential, *virtualAuthenticator) {
		va := newVirtualAuthenticator(t, backup, attach)
		creation, err := v.BeginRegistration(ctx, userID, "alice", "Alice", auth.WebAuthnPlatform)
		if err != nil {
			t.Fatalf("BeginRegistration: %v", err)
		}
		chal := extractChallenge(t, creation)
		cred, err := v.FinishRegistration(ctx, userID, va.createCredential(chal, "example.org", "https://example.org"))
		if err != nil {
			t.Fatalf("FinishRegistration: %v", err)
		}
		cred.MethodID = methodID
		return cred, va
	}

	cred1, va1 := enroll("m-passkey", true, "platform")
	cred2, va2 := enroll("m-securitykey", false, "cross-platform")
	if string(cred1.CredentialID) == string(cred2.CredentialID) {
		t.Fatal("expected distinct credential ids")
	}

	// Log in with the SECOND credential only.
	creds := []auth.WebAuthnCredential{cred1, cred2}
	assertionOpts, err := v.BeginLogin(ctx, userID, "passkey", creds)
	if err != nil {
		t.Fatalf("BeginLogin: %v", err)
	}
	assertResp := va2.createAssertion(extractChallenge(t, assertionOpts), "example.org", "https://example.org")

	matchedMethodID, updatedRecord, err := v.VerifyLogin(ctx, userID, "passkey", creds, assertResp)
	if err != nil {
		t.Fatalf("VerifyLogin: %v", err)
	}
	if matchedMethodID != "m-securitykey" {
		t.Fatalf("matchedMethodID = %q, want m-securitykey (the signing credential)", matchedMethodID)
	}
	var updated wapi.Credential
	if err := json.Unmarshal(updatedRecord, &updated); err != nil {
		t.Fatalf("unmarshal updated record: %v", err)
	}
	if !bytes.Equal(updated.ID, cred2.CredentialID) {
		t.Fatalf("updated record id does not match the signing credential")
	}
	_ = va1 // first authenticator did not participate in this login
}

// TestNew_InvalidConfig verifies New rejects an incomplete config.
func TestNew_InvalidConfig(t *testing.T) {
	cases := []struct {
		name string
		cfg  Config
	}{
		{"empty rp id", Config{RPDisplayName: "x", Origins: []string{"https://x"}}},
		{"empty display name", Config{RPID: "x.org", Origins: []string{"https://x"}}},
		{"empty origins", Config{RPID: "x.org", RPDisplayName: "x"}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := New(tc.cfg)
			if !errors.Is(err, ErrInvalidConfig) {
				t.Fatalf("New(%+v): err=%v, want ErrInvalidConfig", tc.cfg, err)
			}
		})
	}
}
