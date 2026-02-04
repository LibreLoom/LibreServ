package license

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
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
	mu              sync.RWMutex
	entitlement     *Entitlement
	valid           bool
	reason          string
	loadedAt        time.Time
	entitlementPath string
	publicKeyPath   string
}

// Load reads and validates the entitlement with the public key.
func Load(entitlementPath, publicKeyPath string) (*Service, error) {
	svc := &Service{
		entitlementPath: entitlementPath,
		publicKeyPath:   publicKeyPath,
	}

	if err := svc.Reload(); err != nil {
		return nil, err
	}

	return svc, nil
}

// Reload re-reads and validates the entitlement file.
// This allows license refresh without restarting the application.
func (s *Service) Reload() error {
	s.mu.Lock()
	defer s.mu.Unlock()

	data, err := os.ReadFile(s.entitlementPath)
	if err != nil {
		s.valid = false
		s.reason = "entitlement not found"
		s.loadedAt = time.Now()
		return nil
	}

	var ent Entitlement
	if err := json.Unmarshal(data, &ent); err != nil {
		s.entitlement = nil
		s.valid = false
		s.reason = "invalid entitlement json"
		s.loadedAt = time.Now()
		return nil
	}

	if ent.LicenseID == "" || ent.SupportLevel == "" {
		s.entitlement = &ent
		s.valid = false
		s.reason = "missing fields"
		s.loadedAt = time.Now()
		return nil
	}

	// Check expiration
	if ent.ExpiresAt != "" {
		if exp, err := time.Parse(time.RFC3339, ent.ExpiresAt); err == nil {
			if time.Now().After(exp) {
				s.entitlement = &ent
				s.valid = false
				s.reason = "entitlement expired"
				s.loadedAt = time.Now()
				return nil
			}
		}
	}

	// Verify signature if key present
	if s.publicKeyPath != "" {
		pubBytes, err := os.ReadFile(s.publicKeyPath)
		if err != nil {
			s.entitlement = &ent
			s.valid = false
			s.reason = "public key missing"
			s.loadedAt = time.Now()
			return nil
		}
		pubKey, err := parseKey(pubBytes)
		if err != nil {
			s.entitlement = &ent
			s.valid = false
			s.reason = "invalid public key"
			s.loadedAt = time.Now()
			return nil
		}
		payload := signingString(ent)
		sig, err := hex.DecodeString(ent.Signature)
		if err != nil {
			s.entitlement = &ent
			s.valid = false
			s.reason = "invalid signature encoding"
			s.loadedAt = time.Now()
			return nil
		}
		if !ed25519.Verify(pubKey, []byte(payload), sig) {
			s.entitlement = &ent
			s.valid = false
			s.reason = "signature verification failed"
			s.loadedAt = time.Now()
			return nil
		}
	}

	s.entitlement = &ent
	s.valid = true
	s.reason = ""
	s.loadedAt = time.Now()
	return nil
}

// IsExpired checks if the license has expired (time-based check)
func (s *Service) IsExpired() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.entitlement == nil || s.entitlement.ExpiresAt == "" {
		return false
	}

	exp, err := time.Parse(time.RFC3339, s.entitlement.ExpiresAt)
	if err != nil {
		return false
	}

	return time.Now().After(exp)
}

// LoadedAt returns when the license was last loaded
func (s *Service) LoadedAt() time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.loadedAt
}

func parseKey(data []byte) (ed25519.PublicKey, error) {
	trim := strings.TrimSpace(string(data))
	trim = strings.TrimPrefix(trim, "0x")
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
func (s *Service) Valid() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s != nil && s.valid && !s.IsExpired()
}

// Reason returns a human-readable license failure reason.
func (s *Service) Reason() string {
	if s == nil {
		return "license service not initialized"
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.reason
}

// SupportLevel returns the support level if valid.
func (s *Service) SupportLevel() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s == nil || !s.valid || s.entitlement == nil {
		return ""
	}
	return s.entitlement.SupportLevel
}

// LicenseID returns the current license ID if available.
func (s *Service) LicenseID() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s == nil || s.entitlement == nil {
		return ""
	}
	return s.entitlement.LicenseID
}
