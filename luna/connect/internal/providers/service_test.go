package providers

import (
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func testDB(t *testing.T) *database.DB {
	t.Helper()
	// SealString needs an at-rest key; dev mode supplies a deterministic one.
	t.Setenv("LUNACONNECT_DEV", "1")
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	return db
}

func TestProviderCRUD(t *testing.T) {
	db := testDB(t)
	svc := NewService(db)

	p, err := svc.Create("smtp", "Resend", map[string]string{"api_key": "re_test"}, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	list, err := svc.List("smtp")
	if err != nil || len(list) != 1 {
		t.Fatalf("list: %v %#v", err, list)
	}
	found, err := svc.FindEnabled("smtp")
	if err != nil || found == nil || found.Credential("api_key", "") != "re_test" {
		t.Fatalf("find: %v %#v", err, found)
	}
	if err := svc.Update(p.ID, "smtp", "Resend 2", map[string]string{"api_key": ""}, map[string]string{"from_email": "a@b.c"}, true); err != nil {
		t.Fatal(err)
	}
	got, _ := svc.Get(p.ID)
	if got.Credential("api_key", "") != "re_test" {
		t.Fatalf("preserved key=%q", got.Credential("api_key", ""))
	}
	if got.Setting("from_email", "") != "a@b.c" {
		t.Fatalf("settings %+v", got.Settings)
	}
	if err := svc.Delete(p.ID); err != nil {
		t.Fatal(err)
	}
	list, _ = svc.List("")
	if len(list) != 0 {
		t.Fatalf("after delete %#v", list)
	}
}

// Credentials must be sealed at rest; the plaintext key must never appear in
// the stored blob.
func TestProviderCredentialsSealedAtRest(t *testing.T) {
	db := testDB(t)
	svc := NewService(db)

	p, err := svc.Create("smtp", "Resend", map[string]string{"api_key": "re_secret"}, map[string]string{"from_email": "a@b.c"}, true)
	if err != nil {
		t.Fatal(err)
	}
	var credJSON, setJSON string
	if err := db.QueryRow(`SELECT credentials_json, settings_json FROM service_providers WHERE id = ?`, p.ID).
		Scan(&credJSON, &setJSON); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(credJSON, security.SealedPrefix) {
		t.Fatalf("credentials stored unsealed: %q", credJSON)
	}
	if strings.Contains(credJSON, "re_secret") {
		t.Fatalf("credential plaintext leaked into stored blob: %q", credJSON)
	}
	if !strings.Contains(setJSON, "a@b.c") {
		t.Fatalf("settings should stay plain JSON, got %q", setJSON)
	}
	got, err := svc.Get(p.ID)
	if err != nil || got == nil || got.Credential("api_key", "") != "re_secret" {
		t.Fatalf("sealed round-trip: %v %#v", err, got)
	}
}

// Rows written before sealing hold plaintext JSON; reads must still work and
// the row must be re-sealed afterwards.
func TestProviderCredentialsLegacyPlaintextReseal(t *testing.T) {
	db := testDB(t)
	svc := NewService(db)

	p, err := svc.Create("smtp", "Resend", map[string]string{"api_key": "re_test"}, nil, true)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`UPDATE service_providers SET credentials_json = ? WHERE id = ?`,
		`{"api_key":"re_legacy"}`, p.ID); err != nil {
		t.Fatal(err)
	}
	got, err := svc.Get(p.ID)
	if err != nil || got == nil || got.Credential("api_key", "") != "re_legacy" {
		t.Fatalf("legacy read: %v %#v", err, got)
	}
	var credJSON string
	if err := db.QueryRow(`SELECT credentials_json FROM service_providers WHERE id = ?`, p.ID).Scan(&credJSON); err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(credJSON, security.SealedPrefix) {
		t.Fatalf("legacy row not re-sealed on read: %q", credJSON)
	}
	got, err = svc.Get(p.ID)
	if err != nil || got == nil || got.Credential("api_key", "") != "re_legacy" {
		t.Fatalf("post-reseal read: %v %#v", err, got)
	}
}
