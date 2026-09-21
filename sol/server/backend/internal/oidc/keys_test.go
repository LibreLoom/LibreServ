package oidc

import (
	"crypto/rand"
	"crypto/rsa"
	"database/sql"
	"errors"
	"testing"
)

// TestEncodeDecodePublicKey_RoundTrip is a regression test for a latent crash
// in GetAllSigningKeys. encodePublicKey previously stored base64(PEM) while
// parseRSAPublicKey did pem.Decode (expecting raw PEM), so reading any stored
// public key would fail with "failed to decode PEM block". The fix makes
// encodePublicKey store raw PEM. This test verifies the round-trip.
func TestEncodeDecodePublicKey_RoundTrip(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	encoded, err := encodePublicKey(key)
	if err != nil {
		t.Fatalf("encodePublicKey: %v", err)
	}

	parsed, err := parseRSAPublicKey([]byte(encoded))
	if err != nil {
		t.Fatalf("parseRSAPublicKey failed on encodePublicKey output: %v", err)
	}

	if parsed.N.Cmp(key.PublicKey.N) != 0 || parsed.E != key.PublicKey.E {
		t.Errorf("round-tripped public key does not match original")
	}
}

// TestIsNotFound verifies the helper is not the inverted form that returned
// true for nil errors.
func TestIsNotFound(t *testing.T) {
	if isNotFound(nil) {
		t.Errorf("isNotFound(nil) must be false")
	}
	if !isNotFound(sql.ErrNoRows) {
		t.Errorf("isNotFound(sql.ErrNoRows) must be true")
	}
	if isNotFound(errors.New("some other db error")) {
		t.Errorf("isNotFound(other error) must be false")
	}
}
