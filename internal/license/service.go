package license

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"time"
)

// Entitlement represents a signed entitlement file.
type Entitlement struct {
	LicenseID    string `json:"license_id"`
	SupportLevel string `json:"support_level"`
	DeviceID     string `json:"device_id"`
	IssuedAt     string `json:"issued_at"`
	ExpiresAt    string `json:"expires_at,omitempty"`
	Signature    string `json:"signature"`
}

// Service loads and validates entitlements.
type Service struct {
	entitlement *Entitlement
	valid       bool
	reason      string
}

// Load reads and validates the entitlement with the public key.
func Load(entitlementPath, publicKeyPath string) (*Service, error) {
	data, err := os.ReadFile(entitlementPath)
	if err != nil {
		return &Service{valid: false, reason: "entitlement not found"}, nil
	}
	var ent Entitlement
	if err := json.Unmarshal(data, &ent); err != nil {
		return &Service{valid: false, reason: "invalid entitlement json"}, nil
	}
	if ent.LicenseID == "" || ent.SupportLevel == "" {
		return &Service{valid: false, reason: "missing fields"}, nil
	}
	if ent.ExpiresAt != "" {
		if exp, err := time.Parse(time.RFC3339, ent.ExpiresAt); err == nil {
			if time.Now().After(exp) {
				return &Service{entitlement: &ent, valid: false, reason: "entitlement expired"}, nil
			}
		}
	}

	// Verify signature if key present
	if publicKeyPath != "" {
		pubBytes, err := os.ReadFile(publicKeyPath)
		if err != nil {
			return &Service{entitlement: &ent, valid: false, reason: "public key missing"}, nil
		}
		pubKey, err := parseKey(pubBytes)
		if err != nil {
			return &Service{entitlement: &ent, valid: false, reason: "invalid public key"}, nil
		}
		payload := signingString(ent)
		sig, err := hex.DecodeString(ent.Signature)
		if err != nil {
			return &Service{entitlement: &ent, valid: false, reason: "invalid signature encoding"}, nil
		}
		if !ed25519.Verify(pubKey, []byte(payload), sig) {
			return &Service{entitlement: &ent, valid: false, reason: "signature verification failed"}, nil
		}
	}

	return &Service{entitlement: &ent, valid: true}, nil
}

func parseKey(data []byte) (ed25519.PublicKey, error) {
	trim := strings.TrimSpace(string(data))
	if strings.HasPrefix(trim, "0x") {
		trim = strings.TrimPrefix(trim, "0x")
	}
	b, err := hex.DecodeString(trim)
	if err != nil {
		return nil, err
	}
	if len(b) != ed25519.PublicKeySize {
		return nil, errors.New("invalid public key size")
	}
	return ed25519.PublicKey(b), nil
}

func signingString(ent Entitlement) string {
	return strings.Join([]string{
		ent.LicenseID,
		ent.SupportLevel,
		ent.DeviceID,
		ent.IssuedAt,
		ent.ExpiresAt,
	}, "|")
}

// Valid returns whether entitlement is valid.
func (s *Service) Valid() bool { return s != nil && s.valid }

func (s *Service) Reason() string {
	if s == nil {
		return "license service not initialized"
	}
	return s.reason
}

// SupportLevel returns the support level if valid.
func (s *Service) SupportLevel() string {
	if s == nil || !s.valid || s.entitlement == nil {
		return ""
	}
	return s.entitlement.SupportLevel
}

func (s *Service) LicenseID() string {
	if s == nil || s.entitlement == nil {
		return ""
	}
	return s.entitlement.LicenseID
}
