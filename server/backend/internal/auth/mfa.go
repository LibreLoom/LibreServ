package auth

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database/models"
)

// MFA method types.
const (
	MFATypeTOTP        = "totp"
	MFATypeEmail       = "email"
	MFATypePasskey     = "passkey"
	MFATypeSecurityKey = "security_key"
)

// MFA token type carried in the JWT TokenType field.
const mfaTokenType = "mfa"

// ErrMFANotFound is returned when an MFA method lookup fails or the caller
// does not own it.
var ErrMFANotFound = errors.New("mfa method not found")

// ErrMFALastMethod is returned when an operation would leave the user with
// zero enabled MFA methods (softlock prevention; admins must keep ≥1).
var ErrMFALastMethod = errors.New("cannot remove the last enabled mfa method")

// ErrMFAAdminRequired is returned when granting admin to a user with no MFA,
// or when an admin would be left without MFA.
var ErrMFAAdminRequired = errors.New("administrators must have mfa enabled")

// ErrMFAVerifierUnavailable is returned when a webauthn method is requested
// but no WebAuthnVerifier was wired into the service.
var ErrMFAVerifierUnavailable = errors.New("webauthn is not configured")

// WebAuthn ceremony errors (ErrInvalidAssertion / ErrSessionExpired /
// ErrNoCredentials / ErrInvalidConfig) live in package
// internal/auth/webauthn — the verifier returns them + the handlers map them.
// auth.Service passes verifier errors through unchanged (it can't import the
// webauthn package without a cycle); the login-flow Verify handler maps any
// verify failure to 401.

// ErrMFAEncryptionKey is returned when TOTP secrets can't be protected because
// no encryption key is configured (fail closed).
var ErrMFAEncryptionKey = errors.New("totp encryption key not configured")

// mfaTokenTTL is the lifetime of an mfa_token (scoped to MFA verify only).
var mfaTokenTTL = 5 * time.Minute

// MFAMethod is the user-facing MFA method record.
type MFAMethod struct {
	ID         string     `json:"id"`
	Type       string     `json:"type"`
	Label      string     `json:"label"`
	Enabled    bool       `json:"enabled"`
	CreatedAt  time.Time  `json:"created_at"`
	LastUsedAt *time.Time `json:"last_used_at"`
}

// MFAMethodPublic is the shape returned in the login mfa_required response:
// only the picker needs type + label.
type MFAMethodPublic struct {
	Type  string `json:"type"`
	Label string `json:"label"`
}

// MFARequiredResponse is the body returned by Login when the user has MFA.
// mfa_token is short-lived and scoped to /auth/mfa/* — it is NOT a session.
type MFARequiredResponse struct {
	Status   string            `json:"status"` // "mfa_required"
	MFAToken string            `json:"mfa_token"`
	Methods  []MFAMethodPublic `json:"methods"`
}

// MFARequiredError is returned by Login when the password is valid but the
// user has ≥1 enabled MFA method — a session must NOT be issued until an MFA
// verify/recover succeeds. The handler unwraps it (errors.As) to build the
// mfa_required response. It wraps the sentinel ErrMFARequired.
type MFARequiredError struct {
	MFAToken string
	Methods  []MFAMethodPublic
}

func (e *MFARequiredError) Error() string { return "mfa required" }

// ErrMFARequired is the sentinel wrapped by MFARequiredError.
var ErrMFARequired = errors.New("mfa required")

// WebAuthnAttachment distinguishes platform (passkey) vs cross-platform
// (security key) authenticators.
type WebAuthnAttachment string

const (
	WebAuthnPlatform      WebAuthnAttachment = "platform"       // passkey
	WebAuthnCrossPlatform WebAuthnAttachment = "cross-platform" // security_key
)

// WebAuthnCredential is a stored WebAuthn credential, loaded from / persisted
// to mfa_methods by auth.Service. The verifier package works with these as
// values; it never touches the DB. Record is the marshaled go-webauthn
// webauthn.Credential (incl. BackupEligible/BackupState + sign count) — the
// verifier reconstructs the library type from it at login. Storing the whole
// record (vs discrete fields) survives future flag additions without schema
// churn and satisfies the library's BackupEligible enforcement at login.
type WebAuthnCredential struct {
	MethodID     string          // mfa_methods.id (uuid), assigned on persist
	CredentialID []byte          // also inside Record; kept for indexing/logging
	Record       json.RawMessage // marshaled go-webauthn/webauthn.Credential
}

// WebAuthnVerifier is the seam the internal/auth/webauthn package implements.
// auth.Service holds an optional instance (nil = webauthn methods
// unavailable, no crash). The verifier is a pure ceremony engine: it keeps
// its own ephemeral session blobs (keyed by userID, ~5min TTL) and returns
// challenge/assertion JSON for the frontend to pass through to
// navigator.credentials.create/get. auth.Service owns all mfa_methods
// persistence + MFA enforcement.
type WebAuthnVerifier interface {
	// BeginRegistration starts a registration ceremony for the session-authed
	// user. Returns challenge JSON for navigator.credentials.create.
	BeginRegistration(ctx context.Context, userID, username, displayName string, att WebAuthnAttachment) (json.RawMessage, error)
	// FinishRegistration verifies the ceremony and returns the parsed
	// credential. auth.Service persists it.
	FinishRegistration(ctx context.Context, userID string, credential json.RawMessage) (WebAuthnCredential, error)
	// BeginLogin starts a login ceremony. creds are the user's stored enabled
	// credentials of mfaType, loaded by auth.Service. Returns challenge JSON
	// for navigator.credentials.get.
	BeginLogin(ctx context.Context, userID, mfaType string, creds []WebAuthnCredential) (json.RawMessage, error)
	// VerifyLogin verifies the assertion and returns the matched credential's
	// MethodID + an updated Record (with new sign count + flags). auth.Service
	// persists the updated Record + last_used_at on the matched row. nil = success.
	VerifyLogin(ctx context.Context, userID, mfaType string, creds []WebAuthnCredential, assertion json.RawMessage) (matchedMethodID string, updatedRecord json.RawMessage, err error)
}

// MFATOTPEncryptionKeySet reports whether TOTP enrollment is available (the
// at-rest encryption key is configured). Fail-closed if unset.
func (s *Service) MFATOTPEncryptionKeySet() bool { return len(s.mfaTOTPEncryptionKey) > 0 }

// SetMFATOTPEncryptionKey wires the AES-GCM key used to wrap TOTP secrets at
// rest. If empty, TOTP enrollment fails closed. Called from main.go.
func (s *Service) SetMFATOTPEncryptionKey(key string) { s.mfaTOTPEncryptionKey = key }

// SetWebAuthnVerifier wires the WebAuthn verifier (nil = webauthn methods
// unavailable, no crash). Called from main.go after constructing the service.
func (s *Service) SetWebAuthnVerifier(v WebAuthnVerifier) { s.webauthnVerifier = v }

// GenerateTokenPairForUser loads the user + issues a fresh token pair. Used by
// the recovery-code login flow (which completes a session without re-checking
// the password).
func (s *Service) GenerateTokenPairForUser(ctx context.Context, userID string) (*TokenPair, error) {
	user, err := s.GetUserByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	return s.jwtManager.GenerateTokenPair(user.ID, user.Username, user.Role)
}

// ----- mfa_token (scoped JWT, NOT a session) -----

// issueMFAToken returns a short-lived JWT scoped to MFA verify/challenge/recover
// only. It is issued after a valid username+password but before an MFA verify,
// so it must not grant session access. TokenType = "mfa".
func (s *Service) issueMFAToken(userID, username, role string) (string, error) {
	tok, _, err := s.jwtManager.generateToken(userID, username, role, mfaTokenType, mfaTokenTTL)
	return tok, err
}

// ValidateMFAToken validates an mfa_token (scoped, short-lived) and returns the
// user. Used by the MFA login-flow handlers. Rejects access/refresh tokens —
// uses the generic JWT validator (signature+expiry) then checks the mfa type,
// since ValidateAccessToken hard-gates on TokenType "access".
func (s *Service) ValidateMFAToken(ctx context.Context, token string) (*models.User, error) {
	claims, err := s.jwtManager.ValidateToken(token)
	if err != nil {
		return nil, err
	}
	if claims.TokenType != mfaTokenType {
		return nil, ErrInvalidToken
	}
	return s.GetUserByID(ctx, claims.UserID)
}

// ----- listing / enforcement -----

// ListMFAMethods returns a user's MFA methods (public shape; no secrets).
func (s *Service) ListMFAMethods(ctx context.Context, userID string) ([]*MFAMethod, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, type, label, enabled, created_at, last_used_at FROM mfa_methods WHERE user_id = ? ORDER BY created_at ASC`, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list mfa methods: %w", err)
	}
	defer rows.Close()
	var out []*MFAMethod
	for rows.Next() {
		m := &MFAMethod{}
		var enabled int
		if err := rows.Scan(&m.ID, &m.Type, &m.Label, &enabled, &m.CreatedAt, &m.LastUsedAt); err != nil {
			return nil, fmt.Errorf("failed to scan mfa method: %w", err)
		}
		m.Enabled = enabled == 1
		out = append(out, m)
	}
	return out, rows.Err()
}

// enabledMFAMethodTypes returns the type set of a user's enabled methods, for
// the login mfa_required response + enforcement checks.
func (s *Service) enabledMFAMethodTypes(ctx context.Context, userID string) ([]MFAMethodPublic, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT type, label FROM mfa_methods WHERE user_id = ? AND enabled = 1 ORDER BY created_at ASC`, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list enabled mfa methods: %w", err)
	}
	defer rows.Close()
	var out []MFAMethodPublic
	for rows.Next() {
		var m MFAMethodPublic
		if err := rows.Scan(&m.Type, &m.Label); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// HasMFA reports whether the user has at least one enabled MFA method.
func (s *Service) HasMFA(ctx context.Context, userID string) (bool, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mfa_methods WHERE user_id = ? AND enabled = 1`, userID).Scan(&n)
	if err != nil {
		return false, fmt.Errorf("failed to count mfa methods: %w", err)
	}
	return n > 0, nil
}

// countEnabledMFA returns the count of enabled methods.
func (s *Service) countEnabledMFA(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mfa_methods WHERE user_id = ? AND enabled = 1`, userID).Scan(&n)
	if err != nil {
		return 0, fmt.Errorf("failed to count mfa methods: %w", err)
	}
	return n, nil
}

// EnsureAdminMFA enforces that a user being granted (or holding) the admin role
// has ≥1 enabled MFA method. Call this before any role→admin transition.
func (s *Service) EnsureAdminMFA(ctx context.Context, userID string) error {
	has, err := s.HasMFA(ctx, userID)
	if err != nil {
		return err
	}
	if !has {
		return ErrMFAAdminRequired
	}
	return nil
}

// SetMFARequired marks (or clears) the per-user mfa_required flag. When
// setting true, enforces that the user has ≥1 enabled method.
func (s *Service) SetMFARequired(ctx context.Context, userID string, required bool) error {
	if required {
		if err := s.EnsureAdminMFA(ctx, userID); err != nil {
			return err
		}
	}
	_, err := s.db.ExecContext(ctx, `UPDATE users SET mfa_required = ?, updated_at = ? WHERE id = ?`, boolToInt(required), time.Now(), userID)
	return err
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// ----- TOTP -----

// totpData is the JSON stored in mfa_methods.data for a TOTP method.
type totpData struct {
	SecretEnc string `json:"secret_enc"` // AES-GCM(base64) of the TOTP secret
}

// encryptSecret encrypts a TOTP secret with the configured AES-GCM key.
func (s *Service) encryptSecret(secret string) (string, error) {
	key := s.mfaTOTPEncryptionKey
	if len(key) == 0 {
		return "", ErrMFAEncryptionKey
	}
	if len(key) < 32 {
		// Derive a 32-byte key via SHA-256 so short config keys still work.
		h := sha256.Sum256([]byte(key))
		key = string(h[:])
	} else {
		key = key[:32]
	}
	block, err := aes.NewCipher([]byte(key))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	ct := gcm.Seal(nil, nonce, []byte(secret), nil)
	blob := append(nonce, ct...)
	return base64.StdEncoding.EncodeToString(blob), nil
}

// decryptSecret reverses encryptSecret.
func (s *Service) decryptSecret(enc string) (string, error) {
	key := s.mfaTOTPEncryptionKey
	if len(key) == 0 {
		return "", ErrMFAEncryptionKey
	}
	if len(key) < 32 {
		h := sha256.Sum256([]byte(key))
		key = string(h[:])
	} else {
		key = key[:32]
	}
	blob, err := base64.StdEncoding.DecodeString(enc)
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher([]byte(key))
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	ns := gcm.NonceSize()
	if len(blob) < ns+1 {
		return "", errors.New("invalid encrypted secret")
	}
	pt, err := gcm.Open(nil, blob[:ns], blob[ns:], nil)
	if err != nil {
		return "", err
	}
	return string(pt), nil
}

// ----- email OTP -----

// emailOTPData holds an in-flight email OTP. OTPs are short-lived and kept
// in-memory (not persisted) — a fresh challenge re-sends.
type emailOTPData struct {
	code      string
	expiresAt time.Time
	tries     int
}

// generateEmailOTP returns a 6-digit numeric code.
func generateEmailOTP() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	n := uint32(b[0])<<24 | uint32(b[1])<<16 | uint32(b[2])<<8 | uint32(b[3])
	return fmt.Sprintf("%06d", n%1000000)
}

// issueEmailOTP generates + records a 6-digit OTP for the user's email method,
// returning the plaintext code so the handler can email it. TTL 10 min.
func (s *Service) issueEmailOTP(userID, methodID string) (string, error) {
	code := generateEmailOTP()
	s.emailOTPMu.Lock()
	s.emailOTPs[userID+":"+methodID] = emailOTPData{code: code, expiresAt: time.Now().Add(10 * time.Minute)}
	s.emailOTPMu.Unlock()
	return code, nil
}

// verifyEmailOTP validates + consumes the OTP for the given user/method.
func (s *Service) verifyEmailOTP(userID, methodID, code string) error {
	s.emailOTPMu.Lock()
	defer s.emailOTPMu.Unlock()
	k := userID + ":" + methodID
	d, ok := s.emailOTPs[k]
	if !ok {
		return errors.New("no email code sent")
	}
	if time.Now().After(d.expiresAt) {
		delete(s.emailOTPs, k)
		return errors.New("email code expired")
	}
	if d.tries >= 5 {
		delete(s.emailOTPs, k)
		return errors.New("too many attempts")
	}
	s.emailOTPs[k] = emailOTPData{code: d.code, expiresAt: d.expiresAt, tries: d.tries + 1}
	if d.code != code {
		return errors.New("wrong email code")
	}
	delete(s.emailOTPs, k)
	return nil
}

// ----- recovery codes -----

// generateRecoveryCodes returns n single-use recovery codes (bcrypt-hashed at
// rest). The plaintext is returned once for display.
func generateRecoveryCodes(n int) (plaintext []string, hashes []string, err error) {
	for i := 0; i < n; i++ {
		b := make([]byte, 8)
		if _, err := rand.Read(b); err != nil {
			return nil, nil, err
		}
		// Format: xxxx-xxxx (hex, lowercase) — easy to read/type.
		code := fmt.Sprintf("%s-%s", hex.EncodeToString(b[:4]), hex.EncodeToString(b[4:]))
		hash, err := HashPassword(code)
		if err != nil {
			return nil, nil, err
		}
		plaintext = append(plaintext, code)
		hashes = append(hashes, hash)
	}
	return plaintext, hashes, nil
}

// GenerateRecoveryCodes replaces a user's recovery codes and returns the
// plaintext codes exactly once (the user must copy them now).
func (s *Service) GenerateRecoveryCodes(ctx context.Context, userID string) ([]string, error) {
	// Wipe existing.
	if _, err := s.db.ExecContext(ctx, `DELETE FROM mfa_recovery_codes WHERE user_id = ?`, userID); err != nil {
		return nil, fmt.Errorf("failed to clear recovery codes: %w", err)
	}
	plaintext, hashes, err := generateRecoveryCodes(10)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	for _, h := range hashes {
		if _, err := s.db.ExecContext(ctx, `INSERT INTO mfa_recovery_codes (id, user_id, code_hash, created_at) VALUES (?, ?, ?, ?)`, uuid.NewString(), userID, h, now); err != nil {
			return nil, fmt.Errorf("failed to store recovery code: %w", err)
		}
	}
	return plaintext, nil
}

// RecoveryCodesRemaining returns the count of unused recovery codes.
func (s *Service) RecoveryCodesRemaining(ctx context.Context, userID string) (int, error) {
	var n int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL`, userID).Scan(&n)
	return n, err
}

// VerifyRecoveryCode consumes a single-use recovery code. On success returns
// nil; the caller issues a session. Each code is single-use (marked used_at).
func (s *Service) VerifyRecoveryCode(ctx context.Context, userID, code string) error {
	rows, err := s.db.QueryContext(ctx, `SELECT id, code_hash FROM mfa_recovery_codes WHERE user_id = ? AND used_at IS NULL`, userID)
	if err != nil {
		return fmt.Errorf("failed to load recovery codes: %w", err)
	}
	type rc struct{ id, hash string }
	var codes []rc
	for rows.Next() {
		var c rc
		if err := rows.Scan(&c.id, &c.hash); err != nil {
			rows.Close()
			return err
		}
		codes = append(codes, c)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	if len(codes) == 0 {
		return errors.New("no recovery codes left")
	}
	for _, c := range codes {
		if VerifyPassword(c.hash, code) == nil {
			_, err := s.db.ExecContext(ctx, `UPDATE mfa_recovery_codes SET used_at = ? WHERE id = ?`, time.Now(), c.id)
			if err != nil {
				return fmt.Errorf("failed to mark recovery code used: %w", err)
			}
			return nil
		}
	}
	return errors.New("invalid recovery code")
}

// ----- enrollment: TOTP -----

// SetupTOTP generates a TOTP secret + otpauth URI + a base64 PNG QR for the
// user. The method row is created (enabled=0) but NOT enabled until
// VerifyTOTP succeeds. Any existing pending TOTP method is replaced. label is
// optional (defaults to "Authenticator app").
// Returns (secret, otpauthURI, qrImagePNG base64 data URI).
func (s *Service) SetupTOTP(ctx context.Context, userID, username, label string) (string, string, string, error) {
	if strings.TrimSpace(label) == "" {
		label = "Authenticator app"
	}
	secret, otpauthURI, err := generateTOTPSecret(username)
	if err != nil {
		return "", "", "", err
	}
	enc, err := s.encryptSecret(secret)
	if err != nil {
		return "", "", "", err
	}
	// Replace any existing pending (enabled=0) TOTP method for this user.
	if _, err := s.db.ExecContext(ctx, `DELETE FROM mfa_methods WHERE user_id = ? AND type = ? AND enabled = 0`, userID, MFATypeTOTP); err != nil {
		return "", "", "", fmt.Errorf("failed to clear pending totp: %w", err)
	}
	data, _ := json.Marshal(totpData{SecretEnc: enc})
	if _, err = s.db.ExecContext(ctx, `INSERT INTO mfa_methods (id, user_id, type, label, enabled, created_at, data) VALUES (?, ?, ?, ?, 0, ?, ?)`,
		uuid.NewString(), userID, MFATypeTOTP, label, time.Now(), string(data)); err != nil {
		return "", "", "", fmt.Errorf("failed to create totp method: %w", err)
	}
	qr, err := qrPNGDataURI(otpauthURI)
	if err != nil {
		return "", "", "", err
	}
	return secret, otpauthURI, qr, nil
}

// VerifyTOTP verifies a 6-digit code against the user's pending TOTP method and
// enables it. Fails if there is no pending TOTP method or the code is wrong.
func (s *Service) VerifyTOTP(ctx context.Context, userID, code string) error {
	row := s.db.QueryRowContext(ctx, `SELECT id, data FROM mfa_methods WHERE user_id = ? AND type = ? AND enabled = 0 LIMIT 1`, userID, MFATypeTOTP)
	var id, dataStr string
	if err := row.Scan(&id, &dataStr); err != nil {
		return ErrMFANotFound
	}
	var d totpData
	if err := json.Unmarshal([]byte(dataStr), &d); err != nil {
		return err
	}
	secret, err := s.decryptSecret(d.SecretEnc)
	if err != nil {
		return err
	}
	if !validateTOTP(secret, code) {
		return errors.New("wrong code")
	}
	_, err = s.db.ExecContext(ctx, `UPDATE mfa_methods SET enabled = 1 WHERE id = ?`, id)
	return err
}

// ----- enrollment: email -----

// SetupEmail creates a pending email-OTP method and sends a one-time code to
// the user's email to verify they control it. The method is enabled only after
// VerifyEmailSetup succeeds. label is optional (defaults to "Email").
func (s *Service) SetupEmail(ctx context.Context, userID, label string, sendOTP func(email, code string) error) (string, error) {
	if sendOTP == nil {
		return "", errors.New("email otp sender not configured")
	}
	if strings.TrimSpace(label) == "" {
		label = "Email"
	}
	user, err := s.GetUserByID(ctx, userID)
	if err != nil {
		return "", err
	}
	if user.Email == "" {
		return "", errors.New("no email address on your account")
	}
	// Replace any existing pending email method.
	if _, err := s.db.ExecContext(ctx, `DELETE FROM mfa_methods WHERE user_id = ? AND type = ? AND enabled = 0`, userID, MFATypeEmail); err != nil {
		return "", fmt.Errorf("failed to clear pending email method: %w", err)
	}
	id := uuid.NewString()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO mfa_methods (id, user_id, type, label, enabled, created_at, data) VALUES (?, ?, ?, ?, 0, ?, '{}')`,
		id, userID, MFATypeEmail, label, time.Now()); err != nil {
		return "", fmt.Errorf("failed to create email method: %w", err)
	}
	code, err := s.issueEmailOTP(userID, id)
	if err != nil {
		return "", err
	}
	if err := sendOTP(user.Email, code); err != nil {
		return "", fmt.Errorf("failed to send email code: %w", err)
	}
	return id, nil
}

// VerifyEmailSetup verifies the one-time code sent during SetupEmail and
// enables the pending email method.
func (s *Service) VerifyEmailSetup(ctx context.Context, userID, code string) error {
	var methodID string
	if err := s.db.QueryRowContext(ctx, `SELECT id FROM mfa_methods WHERE user_id = ? AND type = ? AND enabled = 0 LIMIT 1`, userID, MFATypeEmail).Scan(&methodID); err != nil {
		return ErrMFANotFound
	}
	if err := s.verifyEmailOTP(userID, methodID, code); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `UPDATE mfa_methods SET enabled = 1 WHERE id = ?`, methodID)
	return err
}

// ----- enrollment: WebAuthn (delegates to the injected verifier) -----

// BeginWebAuthnRegistration starts a WebAuthn registration ceremony.
// mfaType ∈ {passkey, security_key}. label is stored on the method.
func (s *Service) BeginWebAuthnRegistration(ctx context.Context, userID, mfaType, label string) (json.RawMessage, error) {
	if s.webauthnVerifier == nil {
		return nil, ErrMFAVerifierUnavailable
	}
	user, err := s.GetUserByID(ctx, userID)
	if err != nil {
		return nil, err
	}
	att := WebAuthnPlatform
	if mfaType == MFATypeSecurityKey {
		att = WebAuthnCrossPlatform
	}
	// Stash the pending label so CompleteWebAuthnRegistration can persist it.
	s.pendingWebAuthnMu.Lock()
	s.pendingWebAuthnLabel[userID] = label
	s.pendingWebAuthnType[userID] = mfaType
	s.pendingWebAuthnMu.Unlock()
	return s.webauthnVerifier.BeginRegistration(ctx, userID, user.Username, user.Username, att)
}

// CompleteWebAuthnRegistration finishes the ceremony + persists the credential
// as an enabled mfa_methods row. Returns the new method.
func (s *Service) CompleteWebAuthnRegistration(ctx context.Context, userID string, credential json.RawMessage) (*MFAMethod, error) {
	if s.webauthnVerifier == nil {
		return nil, ErrMFAVerifierUnavailable
	}
	s.pendingWebAuthnMu.Lock()
	label, ok := s.pendingWebAuthnLabel[userID]
	mfaType := s.pendingWebAuthnType[userID]
	if ok {
		delete(s.pendingWebAuthnLabel, userID)
		delete(s.pendingWebAuthnType, userID)
	}
	s.pendingWebAuthnMu.Unlock()
	if !ok {
		return nil, errors.New("no pending webauthn registration; call setup first")
	}
	cred, err := s.webauthnVerifier.FinishRegistration(ctx, userID, credential)
	if err != nil {
		return nil, err
	}
	data, _ := json.Marshal(webauthnData{
		CredentialID: base64.RawURLEncoding.EncodeToString(cred.CredentialID),
		Record:       cred.Record,
	})
	id := uuid.NewString()
	if _, err := s.db.ExecContext(ctx, `INSERT INTO mfa_methods (id, user_id, type, label, enabled, created_at, data) VALUES (?, ?, ?, ?, 1, ?, ?)`,
		id, userID, mfaType, label, time.Now(), string(data)); err != nil {
		return nil, fmt.Errorf("failed to create webauthn method: %w", err)
	}
	return &MFAMethod{ID: id, Type: mfaType, Label: label, Enabled: true, CreatedAt: time.Now()}, nil
}

// webauthnData is the JSON stored in mfa_methods.data for webauthn methods.
// Buffer fields use base64url no-pad (RawURLEncoding) — the same encoding the
// go-webauthn library emits natively, so the frontend ↔ verifier seam is
// base64url end-to-end with no conversion at this layer.
type webauthnData struct {
	CredentialID string          `json:"credential_id"` // base64url no-pad
	Record       json.RawMessage `json:"record"`        // marshaled go-webauthn Credential (incl BackupEligible + sign count)
}

// loadWebAuthnCreds loads a user's enabled webauthn credentials of mfaType.
func (s *Service) loadWebAuthnCreds(ctx context.Context, userID, mfaType string) ([]WebAuthnCredential, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, data FROM mfa_methods WHERE user_id = ? AND type = ? AND enabled = 1`, userID, mfaType)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []WebAuthnCredential
	for rows.Next() {
		var id, dataStr string
		if err := rows.Scan(&id, &dataStr); err != nil {
			return nil, err
		}
		var d webauthnData
		if err := json.Unmarshal([]byte(dataStr), &d); err != nil {
			continue
		}
		cid, _ := base64.RawURLEncoding.DecodeString(d.CredentialID)
		out = append(out, WebAuthnCredential{MethodID: id, CredentialID: cid, Record: d.Record})
	}
	return out, rows.Err()
}

// ----- login-flow challenge / verify -----

// BeginMFAChallenge issues a challenge for the given mfaType. For email it
// generates + records an OTP and returns it via sendEmailOTP (the handler
// emails it). For passkey/security_key it returns the WebAuthn options JSON.
// For totp there is nothing to do.
func (s *Service) BeginMFAChallenge(ctx context.Context, userID, mfaType string, sendEmailOTP func(email, code string) error) (json.RawMessage, error) {
	switch mfaType {
	case MFATypeTOTP:
		return json.RawMessage(`{}`), nil
	case MFATypeEmail:
		if sendEmailOTP == nil {
			return nil, errors.New("email otp sender not configured")
		}
		user, err := s.GetUserByID(ctx, userID)
		if err != nil {
			return nil, err
		}
		if user.Email == "" {
			return nil, errors.New("no email address on your account")
		}
		// Find the enabled email method.
		var methodID string
		if err := s.db.QueryRowContext(ctx, `SELECT id FROM mfa_methods WHERE user_id = ? AND type = ? AND enabled = 1 LIMIT 1`, userID, MFATypeEmail).Scan(&methodID); err != nil {
			return nil, ErrMFANotFound
		}
		code, err := s.issueEmailOTP(userID, methodID)
		if err != nil {
			return nil, err
		}
		if err := sendEmailOTP(user.Email, code); err != nil {
			return nil, fmt.Errorf("failed to send email code: %w", err)
		}
		return json.RawMessage(`{"sent":true}`), nil
	case MFATypePasskey, MFATypeSecurityKey:
		if s.webauthnVerifier == nil {
			return nil, ErrMFAVerifierUnavailable
		}
		creds, err := s.loadWebAuthnCreds(ctx, userID, mfaType)
		if err != nil {
			return nil, err
		}
		if len(creds) == 0 {
			return nil, ErrMFANotFound
		}
		return s.webauthnVerifier.BeginLogin(ctx, userID, mfaType, creds)
	default:
		return nil, errors.New("unknown mfa type")
	}
}

// VerifyMFA verifies a challenge for the given mfaType. On success it issues a
// real session token pair (the login completes). payload is method-specific:
// totp/email → {code}; passkey/security_key → {assertion}.
func (s *Service) VerifyMFA(ctx context.Context, userID, username, role, mfaType string, payload json.RawMessage, sendEmailOTP func(email, code string) error) (*TokenPair, error) {
	switch mfaType {
	case MFATypeTOTP:
		var p struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal(payload, &p); err != nil || p.Code == "" {
			return nil, errors.New("please enter your 6-digit code")
		}
		row := s.db.QueryRowContext(ctx, `SELECT id, data FROM mfa_methods WHERE user_id = ? AND type = ? AND enabled = 1 LIMIT 1`, userID, MFATypeTOTP)
		var id, dataStr string
		if err := row.Scan(&id, &dataStr); err != nil {
			return nil, ErrMFANotFound
		}
		var d totpData
		if err := json.Unmarshal([]byte(dataStr), &d); err != nil {
			return nil, err
		}
		secret, err := s.decryptSecret(d.SecretEnc)
		if err != nil {
			return nil, err
		}
		if !validateTOTP(secret, p.Code) {
			return nil, errors.New("wrong code")
		}
		s.touchMFA(ctx, id)
		return s.jwtManager.GenerateTokenPair(userID, username, role)
	case MFATypeEmail:
		var p struct {
			Code string `json:"code"`
		}
		if err := json.Unmarshal(payload, &p); err != nil || p.Code == "" {
			return nil, errors.New("please enter your 6-digit code")
		}
		var methodID string
		if err := s.db.QueryRowContext(ctx, `SELECT id FROM mfa_methods WHERE user_id = ? AND type = ? AND enabled = 1 LIMIT 1`, userID, MFATypeEmail).Scan(&methodID); err != nil {
			return nil, ErrMFANotFound
		}
		if err := s.verifyEmailOTP(userID, methodID, p.Code); err != nil {
			return nil, err
		}
		s.touchMFA(ctx, methodID)
		return s.jwtManager.GenerateTokenPair(userID, username, role)
	case MFATypePasskey, MFATypeSecurityKey:
		if s.webauthnVerifier == nil {
			return nil, ErrMFAVerifierUnavailable
		}
		creds, err := s.loadWebAuthnCreds(ctx, userID, mfaType)
		if err != nil {
			return nil, err
		}
		if len(creds) == 0 {
			return nil, ErrMFANotFound
		}
		var p struct {
			Assertion json.RawMessage `json:"assertion"`
		}
		if err := json.Unmarshal(payload, &p); err != nil || len(p.Assertion) == 0 {
			return nil, errors.New("missing webauthn assertion")
		}
		matchedID, updatedRecord, err := s.webauthnVerifier.VerifyLogin(ctx, userID, mfaType, creds, p.Assertion)
		if err != nil {
			return nil, err
		}
		// Persist the verifier's updated Record (new sign count + flags) on the
		// matched credential's row + last_used_at.
		if matchedID != "" {
			var cid []byte
			for _, c := range creds {
				if c.MethodID == matchedID {
					cid = c.CredentialID
					break
				}
			}
			data, _ := json.Marshal(webauthnData{
				CredentialID: base64.RawURLEncoding.EncodeToString(cid),
				Record:       updatedRecord,
			})
			_, _ = s.db.ExecContext(ctx, `UPDATE mfa_methods SET data = ?, last_used_at = ? WHERE id = ?`, string(data), time.Now(), matchedID)
		}
		return s.jwtManager.GenerateTokenPair(userID, username, role)
	default:
		return nil, errors.New("unknown mfa type")
	}
}

// touchMFA updates last_used_at for a method.
func (s *Service) touchMFA(ctx context.Context, methodID string) {
	_, _ = s.db.ExecContext(ctx, `UPDATE mfa_methods SET last_used_at = ? WHERE id = ?`, time.Now(), methodID)
}

// ----- delete (with enforcement) -----

// DeleteMFAMethod removes an MFA method. Returns ErrMFALastMethod if it would
// leave the user with zero enabled methods (softlock prevention). Ownership-
// scoped: only the user's own method can be deleted.
func (s *Service) DeleteMFAMethod(ctx context.Context, userID, methodID string) error {
	var enabled int
	err := s.db.QueryRowContext(ctx, `SELECT enabled FROM mfa_methods WHERE id = ? AND user_id = ?`, methodID, userID).Scan(&enabled)
	if err != nil {
		return ErrMFANotFound
	}
	if enabled == 1 {
		count, err := s.countEnabledMFA(ctx, userID)
		if err != nil {
			return err
		}
		if count <= 1 {
			return ErrMFALastMethod
		}
	}
	_, err = s.db.ExecContext(ctx, `DELETE FROM mfa_methods WHERE id = ? AND user_id = ?`, methodID, userID)
	return err
}

// ----- helpers (deps isolated in mfa_totp.go + mfa_bcrypt.go) -----

// Strings used by the login-flow picker.
var _ = strings.TrimSpace

// logger accessor for future logging hooks without changing call sites.
func (s *Service) mfaLog() *slog.Logger {
	if s.logger != nil {
		return s.logger.With("component", "mfa")
	}
	return slog.Default()
}
