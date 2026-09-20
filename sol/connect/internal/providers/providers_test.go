package providers

import (
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
)

func TestProviderCRUD(t *testing.T) {
	db := database.OpenTestDB(t)
	svc := NewService(db)

	p, err := svc.Create("backup", "Backblaze B2", map[string]string{
		"account_id":      "acc123",
		"application_key": "key456",
	}, map[string]string{
		"bucket_prefix": "libreserv-backup",
	}, true)
	if err != nil {
		t.Fatalf("create provider: %v", err)
	}
	if p.ID == "" {
		t.Fatal("expected provider id")
	}
	if p.Service != "backup" || p.Name != "Backblaze B2" {
		t.Fatalf("provider mismatch: %v", p)
	}
	if !p.Enabled {
		t.Fatal("expected provider enabled")
	}

	// List all
	all, err := svc.List("")
	if err != nil {
		t.Fatalf("list all: %v", err)
	}
	if len(all) != 1 {
		t.Fatalf("list all count=%d, want 1", len(all))
	}

	// List by service
	backup, err := svc.List("backup")
	if err != nil {
		t.Fatalf("list backup: %v", err)
	}
	if len(backup) != 1 {
		t.Fatalf("list backup count=%d, want 1", len(backup))
	}

	smtp, err := svc.List("smtp")
	if err != nil {
		t.Fatalf("list smtp: %v", err)
	}
	if len(smtp) != 0 {
		t.Fatalf("list smtp count=%d, want 0", len(smtp))
	}

	// Get
	got, err := svc.Get(p.ID)
	if err != nil {
		t.Fatalf("get provider: %v", err)
	}
	if got == nil {
		t.Fatal("expected provider, got nil")
	}
	if got.Credentials["account_id"] != "acc123" {
		t.Fatalf("credential mismatch: %v", got.Credentials)
	}

	// FindEnabled
	enabled, err := svc.FindEnabled("backup")
	if err != nil {
		t.Fatalf("find enabled: %v", err)
	}
	if enabled == nil || enabled.ID != p.ID {
		t.Fatal("expected enabled provider")
	}

	// Update
	if err := svc.Update(p.ID, "backup", "B2 Updated", map[string]string{"account_id": "acc789"}, map[string]string{"bucket_prefix": "backup"}, false); err != nil {
		t.Fatalf("update provider: %v", err)
	}
	updated, err := svc.Get(p.ID)
	if err != nil {
		t.Fatalf("get updated: %v", err)
	}
	if updated.Name != "B2 Updated" {
		t.Fatalf("name=%s, want B2 Updated", updated.Name)
	}
	if updated.Enabled {
		t.Fatal("expected provider disabled")
	}
	if updated.Credentials["account_id"] != "acc789" {
		t.Fatalf("updated credential mismatch: %v", updated.Credentials)
	}

	// Delete
	if err := svc.Delete(p.ID); err != nil {
		t.Fatalf("delete provider: %v", err)
	}
	deleted, err := svc.Get(p.ID)
	if err != nil {
		t.Fatalf("get deleted: %v", err)
	}
	if deleted != nil {
		t.Fatal("expected nil after delete")
	}
}

func TestProviderCredentialAndSetting(t *testing.T) {
	p := &Provider{
		Credentials: map[string]string{"key": "value"},
		Settings:    map[string]string{"zone": "example.com"},
	}
	if p.Credential("key", "fallback") != "value" {
		t.Fatal("credential value mismatch")
	}
	if p.Credential("missing", "fallback") != "fallback" {
		t.Fatal("credential fallback mismatch")
	}
	if p.Setting("zone", "fallback") != "example.com" {
		t.Fatal("setting value mismatch")
	}
	if p.Setting("missing", "fallback") != "fallback" {
		t.Fatal("setting fallback mismatch")
	}
}
