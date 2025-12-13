package license

import (
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadValidEntitlementWithSignature(t *testing.T) {
	dir := t.TempDir()

	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}

	entPath := filepath.Join(dir, "entitlement.json")
	pubPath := filepath.Join(dir, "pubkey")

	ent := Entitlement{
		LicenseID:    "lic-123",
		SupportLevel: "priority",
		DeviceID:     "dev-abc",
		IssuedAt:     time.Now().UTC().Format(time.RFC3339),
		ExpiresAt:    time.Now().Add(1 * time.Hour).UTC().Format(time.RFC3339),
	}
	payload := signingString(ent)
	sig := ed25519.Sign(priv, []byte(payload))
	ent.Signature = hex.EncodeToString(sig)

	writeJSON(t, entPath, ent)
	if err := os.WriteFile(pubPath, []byte(hex.EncodeToString(pub)), 0o600); err != nil {
		t.Fatalf("write pub key: %v", err)
	}

	svc, err := Load(entPath, pubPath)
	if err != nil {
		t.Fatalf("load entitlement: %v", err)
	}
	if !svc.Valid() {
		t.Fatalf("expected valid entitlement, got reason: %s", svc.Reason())
	}
	if svc.SupportLevel() != "priority" {
		t.Fatalf("support level mismatch: %s", svc.SupportLevel())
	}
}

func TestLoadInvalidSignature(t *testing.T) {
	dir := t.TempDir()
	_, priv, _ := ed25519.GenerateKey(nil)
	pub2, _, _ := ed25519.GenerateKey(nil)

	entPath := filepath.Join(dir, "entitlement.json")
	pubPath := filepath.Join(dir, "pubkey")

	ent := Entitlement{
		LicenseID:    "lic-123",
		SupportLevel: "priority",
		DeviceID:     "dev-abc",
		IssuedAt:     time.Now().UTC().Format(time.RFC3339),
		ExpiresAt:    time.Now().Add(1 * time.Hour).UTC().Format(time.RFC3339),
	}
	payload := signingString(ent)
	sig := ed25519.Sign(priv, []byte(payload))
	ent.Signature = hex.EncodeToString(sig)

	writeJSON(t, entPath, ent)
	if err := os.WriteFile(pubPath, []byte(hex.EncodeToString(pub2)), 0o600); err != nil {
		t.Fatalf("write pub key: %v", err)
	}

	svc, err := Load(entPath, pubPath)
	if err != nil {
		t.Fatalf("load entitlement: %v", err)
	}
	if svc.Valid() {
		t.Fatalf("expected invalid entitlement")
	}
}

func writeJSON(t *testing.T, path string, ent Entitlement) {
	t.Helper()
	data, err := json.Marshal(ent)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, data, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
}
