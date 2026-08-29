package providers

import (
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
)

func TestProviderCRUD(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
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
