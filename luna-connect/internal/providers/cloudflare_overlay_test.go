package providers

import (
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
)

func TestRefreshCloudflareLoadsPeerAdminWrite(t *testing.T) {
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}

	prev := config.C.Cloudflare
	t.Cleanup(func() {
		config.C.Cloudflare = prev
		SetCloudflareRuntimeDB(nil)
		CaptureCloudflareBase()
	})

	config.C.Cloudflare = config.CloudflareConfig{
		AccountID: "yaml-account",
		APIToken:  "yaml-token",
		ZoneID:    "yaml-zone",
	}
	CaptureCloudflareBase()
	SetCloudflareRuntimeDB(db)

	svc := NewService(db)
	_, err = svc.Create("cloudflare", "Cloudflare", map[string]string{
		"account_id": "peer-account",
		"api_token":  "peer-token",
	}, map[string]string{
		"zone_id": "peer-zone",
	}, true)
	if err != nil {
		t.Fatal(err)
	}

	if config.C.Cloudflare.AccountID != "yaml-account" {
		t.Fatalf("pre-refresh account=%q", config.C.Cloudflare.AccountID)
	}

	RefreshCloudflare()
	if config.C.Cloudflare.AccountID != "peer-account" {
		t.Fatalf("account_id=%q", config.C.Cloudflare.AccountID)
	}
	if config.C.Cloudflare.APIToken != "peer-token" {
		t.Fatalf("api_token=%q", config.C.Cloudflare.APIToken)
	}
	if config.C.Cloudflare.ZoneID != "peer-zone" {
		t.Fatalf("zone_id=%q", config.C.Cloudflare.ZoneID)
	}
	if !config.C.Cloudflare.Ready() {
		t.Fatal("expected cloudflare ready after refresh")
	}
}
