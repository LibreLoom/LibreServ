package services

import (
	"database/sql"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// TestActivationClaimsUnassignedDomain verifies the orphan-hole fix: a domain
// bought during onboarding (device_id NULL) gets claimed and served when the
// device activates.
func TestActivationClaimsUnassignedDomain(t *testing.T) {
	db := database.OpenTestDB(t)

	accountID := "acc-" + security.RandomString(8)
	_, _ = db.Exec(`INSERT INTO customer_accounts (id, email, password_hash, plan_id) VALUES ($1, $2, 'hash', 'free')`,
		accountID, accountID+"@test.com")
	deviceID := "dev-" + security.RandomString(8)
	_, _ = db.Exec(`INSERT INTO devices (id, account_id, plan_id, subdomain) VALUES ($1, $2, 'free', 'mypick')`,
		deviceID, accountID)
	// Unassigned domain bought during onboarding.
	_, _ = db.Exec(`INSERT INTO custom_domains (id, account_id, domain, registered_via, auto_renew, status, expires_at)
		VALUES ($1, $2, 'example.com', 'cloudflare', TRUE, 'active', $3)`,
		"dom-"+security.RandomString(8), accountID, time.Now().AddDate(1, 0, 0))

	coord := NewDomainCoordinator(db)
	if err := coord.Activation(deviceID); err != nil {
		t.Fatalf("activation reconcile: %v", err)
	}

	// The domain must now be claimed by the device and be the serving domain.
	var deviceIDInRow sql.NullString
	if err := db.QueryRow(`SELECT device_id FROM custom_domains WHERE domain = 'example.com'`).Scan(&deviceIDInRow); err != nil {
		t.Fatalf("query domain: %v", err)
	}
	if !deviceIDInRow.Valid || deviceIDInRow.String != deviceID {
		t.Fatalf("domain not claimed: device_id=%v, want %s", deviceIDInRow, deviceID)
	}

	serving, isCustom, err := coord.ServingDomain(deviceID)
	if err != nil {
		t.Fatalf("serving domain: %v", err)
	}
	if !isCustom || serving != "example.com" {
		t.Fatalf("serving domain = %q custom=%v, want example.com custom=true", serving, isCustom)
	}
}

// TestActivationNoDomainFallsBackToSubdomain verifies that without a custom
// domain, activation serves the device's chosen subdomain.
func TestActivationNoDomainFallsBackToSubdomain(t *testing.T) {
	db := database.OpenTestDB(t)

	accountID := "acc-" + security.RandomString(8)
	_, _ = db.Exec(`INSERT INTO customer_accounts (id, email, password_hash, plan_id) VALUES ($1, $2, 'hash', 'free')`,
		accountID, accountID+"@test.com")
	deviceID := "dev-" + security.RandomString(8)
	_, _ = db.Exec(`INSERT INTO devices (id, account_id, plan_id, subdomain) VALUES ($1, $2, 'free', 'mypick')`,
		deviceID, accountID)

	coord := NewDomainCoordinator(db)
	if err := coord.Activation(deviceID); err != nil {
		t.Fatalf("activation reconcile: %v", err)
	}

	serving, isCustom, err := coord.ServingDomain(deviceID)
	if err != nil {
		t.Fatalf("serving domain: %v", err)
	}
	if isCustom {
		t.Fatalf("expected subdomain, got custom %q", serving)
	}
	if serving != "mypick.free.servers.libreloom.org" {
		t.Fatalf("serving = %q, want mypick.free.servers.libreloom.org", serving)
	}
}
