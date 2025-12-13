package support

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

type fakeLicense struct {
	valid        bool
	supportLevel string
	licenseID    string
	reason       string
}

func (f fakeLicense) Valid() bool          { return f.valid }
func (f fakeLicense) SupportLevel() string { return f.supportLevel }
func (f fakeLicense) LicenseID() string    { return f.licenseID }
func (f fakeLicense) Reason() string       { return f.reason }

func TestSupportService_CreateValidateRevoke(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	lic := fakeLicense{valid: true, supportLevel: "priority", licenseID: "lic-1"}
	svc := NewService(db, lic)

	sess, err := svc.CreateSession(context.Background(), CreateRequest{
		Scopes:    []string{"diagnostics"},
		TTL:       30 * time.Minute,
		CreatedBy: "admin",
	})
	if err != nil {
		t.Fatalf("create session: %v", err)
	}
	if sess.SupportLevel != "priority" || sess.LicenseID != "lic-1" {
		t.Fatalf("support level/license not set")
	}

	got, err := svc.ValidateCode(context.Background(), sess.Code, sess.Token)
	if err != nil {
		t.Fatalf("validate: %v", err)
	}
	if got.ID != sess.ID {
		t.Fatalf("unexpected session id: %s", got.ID)
	}

	if err := svc.RevokeSession(context.Background(), sess.ID, "admin"); err != nil {
		t.Fatalf("revoke: %v", err)
	}
	if _, err := svc.ValidateCode(context.Background(), sess.Code, sess.Token); err == nil {
		t.Fatalf("expected validate failure after revoke")
	}

	// Expiry handling
	expired, err := svc.CreateSession(context.Background(), CreateRequest{TTL: -1 * time.Minute})
	if err != nil {
		t.Fatalf("create expired session: %v", err)
	}
	if _, err := svc.ValidateCode(context.Background(), expired.Code, expired.Token); err == nil {
		t.Fatalf("expected expired validation failure")
	}
}

func TestSupportService_RequiresValidLicense(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, _ := database.Open(dbPath)
	_ = db.Migrate()
	lic := fakeLicense{valid: false, reason: "invalid"}
	svc := NewService(db, lic)

	_, err := svc.CreateSession(context.Background(), CreateRequest{})
	if err == nil {
		t.Fatalf("expected error when license invalid")
	}
}
