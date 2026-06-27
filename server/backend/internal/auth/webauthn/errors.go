package webauthn

import "errors"

// Sentinel errors returned by the Verifier. Callers (the MFA service) map these
// to HTTP statuses: invalid assertion/credential -> 401; expired/missing
// ceremony session -> 400 (re-challenge); no credentials -> 400; bad config ->
// 500 / skip wiring.
var (
	// ErrInvalidAssertion indicates a registration or login ceremony failed
	// verification (bad signature, unknown credential, challenge mismatch,
	// malformed response). Map to 401.
	ErrInvalidAssertion = errors.New("invalid webauthn assertion or credential")

	// ErrSessionExpired indicates no in-flight ceremony session exists for the
	// user, or the session TTL elapsed. The client must re-begin. Map to 400.
	ErrSessionExpired = errors.New("webauthn session expired or not found")

	// ErrNoCredentials indicates BeginLogin was called for a user with no
	// stored enabled credentials of the requested type. Map to 400.
	ErrNoCredentials = errors.New("no webauthn credentials registered for user")

	// ErrInvalidConfig indicates the Verifier could not be constructed
	// (missing RP ID / origins, invalid domain, etc.). Log + skip wiring.
	ErrInvalidConfig = errors.New("invalid webauthn config")
)
