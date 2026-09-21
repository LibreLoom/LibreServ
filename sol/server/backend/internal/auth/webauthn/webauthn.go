// Package webauthn implements the WebAuthn (passkey + security key) ceremonies
// for LibreServ's multi-factor authentication. It is a pure-ceremony package:
// it holds only the ephemeral challenge/session state in memory and performs
// the register/login round-trips against github.com/go-webauthn/webauthn. All
// credential persistence (the mfa_methods rows) is owned by the parent
// auth.Service; this package returns parsed credential records for the service
// to persist and accepts the stored records back to build login challenges.
//
// The package implements the auth.WebAuthnVerifier interface defined in
// internal/auth/mfa.go. The dependency is one-way: webauthn -> auth (interface
// + types); auth never imports webauthn, so there is no cycle. main.go wires a
// *Verifier into the auth service via Service.SetWebAuthnVerifier; a nil
// verifier means WebAuthn methods are unavailable.
//
// Attachment model: a "passkey" is a platform authenticator
// (AuthenticatorAttachment == "platform"); a "security key" is a roaming
// authenticator ("cross-platform"). The two share one WebAuthn ceremony and
// differ only in the authenticator-selection criteria sent at registration.
package webauthn

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"

	"github.com/go-webauthn/webauthn/protocol"
	wapi "github.com/go-webauthn/webauthn/webauthn"
)

// Compile-time guarantee that *Verifier satisfies auth.WebAuthnVerifier.
var _ auth.WebAuthnVerifier = (*Verifier)(nil)

// DefaultTimeout is the ceremony timeout used when Config.Timeout is zero. It is
// enforced both server-side (the session expires) and sent to the client.
const DefaultTimeout = 60 * time.Second

// Config configures the Relying Party. RPID is the effective domain (e.g.
// "libreserv.example.com"); Origins are the fully-qualified origins permitted to
// perform ceremonies (e.g. ["https://libreserv.example.com"]). WebAuthn
// requires https origins (browsers also treat http://localhost as secure), so
// in a non-https dev setup leave Origins empty and do not wire the verifier.
type Config struct {
	RPID          string
	RPDisplayName string
	Origins       []string
	Timeout       time.Duration
}

// Verifier performs WebAuthn register/login ceremonies. A nil verifier (not
// constructed) means WebAuthn methods are unavailable.
type Verifier struct {
	wa       *wapi.WebAuthn
	timeout  time.Duration
	sessions *sessionStore
	log      *slog.Logger
}

// New constructs a Verifier from the Relying-Party config. It returns
// ErrInvalidConfig (wrapping the underlying cause) if RPID/RPDisplayName/Origins
// are missing or the RPID is not a valid domain.
func New(cfg Config) (*Verifier, error) {
	if cfg.RPID == "" || cfg.RPDisplayName == "" || len(cfg.Origins) == 0 {
		return nil, fmt.Errorf("%w: rp_id, rp_display_name and origins are required", ErrInvalidConfig)
	}
	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = DefaultTimeout
	}
	wa, err := wapi.New(&wapi.Config{
		RPID:          cfg.RPID,
		RPDisplayName: cfg.RPDisplayName,
		RPOrigins:     cfg.Origins,
		Timeouts: wapi.TimeoutsConfig{
			Registration: wapi.TimeoutConfig{Enforce: true, Timeout: timeout, TimeoutUVD: timeout},
			Login:        wapi.TimeoutConfig{Enforce: true, Timeout: timeout, TimeoutUVD: timeout},
		},
		AttestationPreference: protocol.PreferNoAttestation,
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrInvalidConfig, err)
	}
	return &Verifier{
		wa:       wa,
		timeout:  timeout,
		sessions: &sessionStore{m: make(map[string]sessionEntry), ttl: timeout},
		log:      slog.Default().With("component", "webauthn-verifier"),
	}, nil
}

// Timeout returns the configured ceremony timeout.
func (v *Verifier) Timeout() time.Duration { return v.timeout }

// BeginRegistration starts a registration ceremony for a session-authed user.
// It returns the PublicKeyCredentialCreationOptions as JSON (base64url-encoded
// buffers per the WebAuthn JSON convention) for the client to pass to
// navigator.credentials.create. The ephemeral challenge session is held
// in-memory keyed by userID; FinishRegistration consumes it.
func (v *Verifier) BeginRegistration(ctx context.Context, userID, username, displayName string, att auth.WebAuthnAttachment) (json.RawMessage, error) {
	sel, err := selectionFor(att)
	if err != nil {
		return nil, err
	}
	user := &webAuthnUser{id: []byte(userID), name: username, display: displayName}
	creation, sess, err := v.wa.BeginRegistration(user, wapi.WithAuthenticatorSelection(sel))
	if err != nil {
		return nil, fmt.Errorf("begin registration: %w", err)
	}
	v.sessions.put(regKey(userID), sess)
	out, err := json.Marshal(creation)
	if err != nil {
		return nil, fmt.Errorf("marshal credential creation options: %w", err)
	}
	return out, nil
}

// FinishRegistration validates the client's navigator.credentials.create
// response (credential JSON) and returns the parsed credential record for the
// auth service to persist. The challenge session is consumed (single-use).
func (v *Verifier) FinishRegistration(ctx context.Context, userID string, credential json.RawMessage) (auth.WebAuthnCredential, error) {
	sess, err := v.sessions.take(regKey(userID))
	if err != nil {
		return auth.WebAuthnCredential{}, err
	}
	parsed, err := protocol.ParseCredentialCreationResponseBytes(credential)
	if err != nil {
		return auth.WebAuthnCredential{}, fmt.Errorf("%w: parse credential response: %v", ErrInvalidAssertion, err)
	}
	user := &webAuthnUser{id: []byte(userID)}
	cred, err := v.wa.CreateCredential(user, *sess, parsed)
	if err != nil {
		return auth.WebAuthnCredential{}, fmt.Errorf("%w: %v", ErrInvalidAssertion, err)
	}
	record, err := json.Marshal(cred)
	if err != nil {
		return auth.WebAuthnCredential{}, fmt.Errorf("marshal credential record: %w", err)
	}
	return auth.WebAuthnCredential{CredentialID: cred.ID, Record: record}, nil
}

// BeginLogin starts a login ceremony. creds are the user's stored enabled
// credentials of mfaType ("passkey"|"security_key"), loaded by the auth
// service; they populate the allowCredentials list. Returns the
// PublicKeyCredentialRequestOptions as JSON for navigator.credentials.get.
func (v *Verifier) BeginLogin(ctx context.Context, userID, mfaType string, creds []auth.WebAuthnCredential) (json.RawMessage, error) {
	waCreds, err := toWACredentials(creds)
	if err != nil {
		return nil, err
	}
	if len(waCreds) == 0 {
		return nil, ErrNoCredentials
	}
	user := &webAuthnUser{id: []byte(userID), credentials: waCreds}
	opts := []wapi.LoginOption{wapi.WithUserVerification(verificationFor(mfaType))}
	assertion, sess, err := v.wa.BeginLogin(user, opts...)
	if err != nil {
		return nil, fmt.Errorf("begin login: %w", err)
	}
	v.sessions.put(loginKey(userID), sess)
	out, err := json.Marshal(assertion)
	if err != nil {
		return nil, fmt.Errorf("marshal assertion options: %w", err)
	}
	return out, nil
}

// VerifyLogin validates the client's navigator.credentials.get response
// (assertion JSON) against the stored credentials. On success it returns the
// MethodID of the matched credential and the updated credential record (new
// sign count + flags) for the auth service to persist verbatim. The challenge
// session is consumed (single-use). A nil error means the assertion is valid.
func (v *Verifier) VerifyLogin(ctx context.Context, userID, mfaType string, creds []auth.WebAuthnCredential, assertion json.RawMessage) (string, json.RawMessage, error) {
	sess, err := v.sessions.take(loginKey(userID))
	if err != nil {
		return "", nil, err
	}
	waCreds, err := toWACredentials(creds)
	if err != nil {
		return "", nil, err
	}
	if len(waCreds) == 0 {
		return "", nil, ErrNoCredentials
	}
	user := &webAuthnUser{id: []byte(userID), credentials: waCreds}
	parsed, err := protocol.ParseCredentialRequestResponseBytes(assertion)
	if err != nil {
		return "", nil, fmt.Errorf("%w: parse assertion response: %v", ErrInvalidAssertion, err)
	}
	matched, err := v.wa.ValidateLogin(user, *sess, parsed)
	if err != nil {
		return "", nil, fmt.Errorf("%w: %v", ErrInvalidAssertion, err)
	}
	// ValidateLogin mutates + returns the matched library credential (by ID).
	// Map it back to the input row's MethodID; waCreds[i] aligns with creds[i].
	var matchedMethodID string
	for i, wc := range waCreds {
		if bytes.Equal(wc.ID, matched.ID) {
			matchedMethodID = creds[i].MethodID
			break
		}
	}
	if matchedMethodID == "" {
		return "", nil, fmt.Errorf("%w: matched credential id not found among stored credentials", ErrInvalidAssertion)
	}
	updated, err := json.Marshal(matched)
	if err != nil {
		return "", nil, fmt.Errorf("marshal updated credential record: %w", err)
	}
	return matchedMethodID, updated, nil
}

// selectionFor builds the authenticator-selection criteria for an attachment:
// passkeys require a resident (discoverable) key + user verification; security
// keys prefer a resident key and prefer (but don't require) UV.
func selectionFor(att auth.WebAuthnAttachment) (protocol.AuthenticatorSelection, error) {
	switch att {
	case auth.WebAuthnPlatform:
		return protocol.AuthenticatorSelection{
			AuthenticatorAttachment: protocol.Platform,
			ResidentKey:             protocol.ResidentKeyRequirementRequired,
			RequireResidentKey:      protocol.ResidentKeyRequired(),
			UserVerification:        protocol.VerificationRequired,
		}, nil
	case auth.WebAuthnCrossPlatform:
		return protocol.AuthenticatorSelection{
			AuthenticatorAttachment: protocol.CrossPlatform,
			ResidentKey:             protocol.ResidentKeyRequirementPreferred,
			RequireResidentKey:      protocol.ResidentKeyNotRequired(),
			UserVerification:        protocol.VerificationPreferred,
		}, nil
	default:
		return protocol.AuthenticatorSelection{}, fmt.Errorf("%w: unknown attachment %q", ErrInvalidConfig, att)
	}
}

func verificationFor(mfaType string) protocol.UserVerificationRequirement {
	if mfaType == "passkey" {
		return protocol.VerificationRequired
	}
	return protocol.VerificationPreferred
}

func toWACredentials(creds []auth.WebAuthnCredential) ([]wapi.Credential, error) {
	out := make([]wapi.Credential, 0, len(creds))
	for _, c := range creds {
		if len(c.Record) == 0 {
			continue
		}
		var wc wapi.Credential
		if err := json.Unmarshal(c.Record, &wc); err != nil {
			return nil, fmt.Errorf("%w: corrupt credential record: %v", ErrInvalidAssertion, err)
		}
		out = append(out, wc)
	}
	return out, nil
}

// webAuthnUser adapts LibreServ user data to the go-webauthn User interface.
// WebAuthnID is the opaque user handle; we use the user's account ID bytes
// (stable, unique). For MFA (not passwordless) this is acceptable.
type webAuthnUser struct {
	id          []byte
	name        string
	display     string
	credentials []wapi.Credential
}

func (u *webAuthnUser) WebAuthnID() []byte                     { return u.id }
func (u *webAuthnUser) WebAuthnName() string                   { return u.name }
func (u *webAuthnUser) WebAuthnDisplayName() string            { return u.display }
func (u *webAuthnUser) WebAuthnCredentials() []wapi.Credential { return u.credentials }

// sessionStore holds in-flight ceremony sessions (the go-webauthn SessionData,
// which carries the challenge) keyed by userID, with a TTL. Sessions are
// single-use: take() removes them. Registration and login use disjoint keys so
// an enrollment session can never collide with a login session.
type sessionStore struct {
	mu  sync.Mutex
	m   map[string]sessionEntry
	ttl time.Duration
}

type sessionEntry struct {
	data    *wapi.SessionData
	expires time.Time
}

func (s *sessionStore) put(key string, data *wapi.SessionData) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[key] = sessionEntry{data: data, expires: time.Now().Add(s.ttl)}
}

func (s *sessionStore) take(key string) (*wapi.SessionData, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.m[key]
	delete(s.m, key) // single-use regardless of outcome
	if !ok || time.Now().After(e.expires) {
		return nil, ErrSessionExpired
	}
	return e.data, nil
}

func regKey(userID string) string   { return "reg:" + userID }
func loginKey(userID string) string { return "login:" + userID }
