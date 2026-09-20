package providers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
)

func TestEnsureDeviceBucketIdempotent(t *testing.T) {
	prev := os.Getenv("LUNACONNECT_DEV")
	_ = os.Setenv("LUNACONNECT_DEV", "1")
	t.Cleanup(func() { _ = os.Setenv("LUNACONNECT_DEV", prev) })
	config.C.Server.AtRestKey = ""

	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, created_at)
VALUES ('acct_1', 'a@example.com', 'x', 1, 'active', 1)`)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`INSERT INTO devices (id, account_id, code_hash, name, subdomain, local_port, created_at)
VALUES ('dev_abc12345abcdef', 'acct_1', 'th', 'Luna', 'kitchen', 8090, 1)`)
	if err != nil {
		t.Fatal(err)
	}

	createBucketCalls := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/b2api/v2/b2_authorize_account" {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accountId":          "acc",
				"authorizationToken": "tok",
				"apiUrl":             "http://" + r.Host,
				"s3ApiUrl":           "https://s3.us-west-001.backblazeb2.com",
			})
			return
		}
		if strings.Contains(r.URL.Path, "b2_create_bucket") {
			createBucketCalls++
			_ = json.NewEncoder(w).Encode(map[string]string{
				"bucketId": "buc1", "bucketName": "luna-backup-dev-abc12345abcdef",
			})
			return
		}
		if strings.Contains(r.URL.Path, "b2_create_key") {
			_ = json.NewEncoder(w).Encode(map[string]string{
				"applicationKeyId": "kid", "applicationKey": "secret-key-value",
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	svc := NewService(db)
	_, err = svc.Create("backup", "B2", map[string]string{
		"account_id":      "acc",
		"application_key": "master",
	}, map[string]string{"bucket_prefix": "luna-backup"}, true)
	if err != nil {
		t.Fatal(err)
	}

	client := NewB2Client(ts.Client())
	client.authorizeURL = ts.URL + "/b2api/v2/b2_authorize_account"
	p := &BucketProvisioner{DB: db, Providers: svc, B2: client}

	first, err := p.EnsureDeviceBucket("dev_abc12345abcdef")
	if err != nil {
		t.Fatalf("first: %v", err)
	}
	if first.BucketID != "buc1" || first.Key != "secret-key-value" {
		t.Fatalf("first=%+v", first)
	}
	second, err := p.EnsureDeviceBucket("dev_abc12345abcdef")
	if err != nil {
		t.Fatalf("second: %v", err)
	}
	if createBucketCalls != 1 {
		t.Fatalf("createBucketCalls=%d want 1", createBucketCalls)
	}
	if second.KeyID != first.KeyID || second.BucketName != first.BucketName {
		t.Fatalf("second=%+v first=%+v", second, first)
	}
}

func TestEnsureDeviceBucketMissingProvider(t *testing.T) {
	prev := os.Getenv("LUNACONNECT_DEV")
	_ = os.Setenv("LUNACONNECT_DEV", "1")
	t.Cleanup(func() { _ = os.Setenv("LUNACONNECT_DEV", prev) })

	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}

	p := &BucketProvisioner{DB: db, Providers: NewService(db), B2: NewB2Client(nil)}
	_, err = p.EnsureDeviceBucket("dev_x")
	if err != ErrBackupNotConfigured {
		t.Fatalf("err=%v", err)
	}
}
