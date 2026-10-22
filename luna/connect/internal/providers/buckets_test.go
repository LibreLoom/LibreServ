package providers

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
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

func TestBucketNameUniqueAndBounded(t *testing.T) {
	a := bucketName("luna-backup", BucketKey("acct_1", "storage-luna-abcdefghijklmnopqrstuvwxyz"))
	b := bucketName("luna-backup", BucketKey("acct_1", "storage-luna-abcdefghijklmnopqrstuvwxy2"))
	c := bucketName("luna-backup", BucketKey("acct_2", "storage-luna-abcdefghijklmnopqrstuvwxyz"))
	if a == b || a == c || b == c {
		t.Fatalf("names collide: %s %s %s", a, b, c)
	}
	long := bucketName("a-very-long-prefix-from-settings", "k")
	if len(a) > 50 || len(long) > 50 || len(long) < 6 {
		t.Fatalf("bad lengths %d %d", len(a), len(long))
	}
}

func TestB2AuthorizeIsCached(t *testing.T) {
	calls := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		_ = json.NewEncoder(w).Encode(map[string]any{"accountId": "a", "authorizationToken": "t", "apiUrl": "http://x"})
	}))
	defer ts.Close()
	c := NewB2Client(ts.Client())
	c.authorizeURL = ts.URL
	for i := 0; i < 3; i++ {
		if _, err := c.Authorize("a", "k"); err != nil {
			t.Fatal(err)
		}
	}
	if calls != 1 {
		t.Fatalf("authorize calls = %d, want 1", calls)
	}
	c.forgetAuth("a", "k")
	_, _ = c.Authorize("a", "k")
	if calls != 2 {
		t.Fatalf("after forget calls = %d, want 2", calls)
	}
}

func TestEnsureDeviceBucketRevokesLostRaceKey(t *testing.T) {
	prev := os.Getenv("LUNACONNECT_DEV")
	_ = os.Setenv("LUNACONNECT_DEV", "1")
	t.Cleanup(func() { _ = os.Setenv("LUNACONNECT_DEV", prev) })
	config.C.Server.AtRestKey = ""
	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	key := BucketKey("acct_1", "storage-luna-x")
	var deleted []string
	var deletedBuckets []string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/b2api/v2/b2_authorize_account":
			_ = json.NewEncoder(w).Encode(map[string]any{"accountId": "acc", "authorizationToken": "tok",
				"apiUrl": "http://" + r.Host, "s3ApiUrl": "https://s3.example"})
		case strings.Contains(r.URL.Path, "b2_create_bucket"):
			// Another instance saves its own row while this one is still provisioning.
			_, _ = db.Exec(`INSERT INTO device_backup_buckets (device_id, bucket_name, bucket_id, endpoint, key_id, application_key_sealed, provisioned_at)
VALUES (?, 'other', 'buc0', 'e', 'winner', '', 1)`, key)
			_ = json.NewEncoder(w).Encode(map[string]string{"bucketId": "buc1"})
		case strings.Contains(r.URL.Path, "b2_create_key"):
			_ = json.NewEncoder(w).Encode(map[string]string{"applicationKeyId": "loser", "applicationKey": "s"})
		case strings.Contains(r.URL.Path, "b2_delete_key"):
			var req map[string]string
			_ = json.NewDecoder(r.Body).Decode(&req)
			deleted = append(deleted, req["applicationKeyId"])
			_, _ = w.Write([]byte(`{}`))
		case strings.Contains(r.URL.Path, "b2_delete_bucket"):
			var req map[string]string
			_ = json.NewDecoder(r.Body).Decode(&req)
			deletedBuckets = append(deletedBuckets, req["bucketId"])
			_, _ = w.Write([]byte(`{}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()
	svc := NewService(db)
	if _, err := svc.Create("backup", "B2", map[string]string{"account_id": "acc", "application_key": "master"}, nil, true); err != nil {
		t.Fatal(err)
	}
	client := NewB2Client(ts.Client())
	client.authorizeURL = ts.URL + "/b2api/v2/b2_authorize_account"
	p := &BucketProvisioner{DB: db, Providers: svc, B2: client}

	// The row exists only after create_bucket runs, so the first look finds nothing.
	got, err := p.EnsureDeviceBucket(key)
	if err != nil {
		t.Fatal(err)
	}
	if got.KeyID != "winner" {
		t.Fatalf("kept key %q, want the winner's", got.KeyID)
	}
	if len(deleted) != 1 || deleted[0] != "loser" {
		t.Fatalf("revoked keys = %v, want [loser]", deleted)
	}

	// Releasing the account frees the bucket, then the key, then the row.
	if err := p.ReleaseBuckets("acct_1", ""); err != nil {
		t.Fatal(err)
	}
	if len(deletedBuckets) != 1 || deletedBuckets[0] != "buc0" {
		t.Fatalf("deleted buckets = %v", deletedBuckets)
	}
	var n int
	_ = db.QueryRow(`SELECT COUNT(*) FROM device_backup_buckets`).Scan(&n)
	if n != 0 {
		t.Fatalf("row left behind (%d)", n)
	}
	// Another account's bucket is untouched.
	_, _ = db.Exec(`INSERT INTO device_backup_buckets (device_id, bucket_name, bucket_id, endpoint, key_id, application_key_sealed, provisioned_at)
VALUES ('acct_10:storage-luna-y', 'n', 'b', 'e', 'k', '', 1)`)
	if err := p.ReleaseBuckets("acct_1", ""); err != nil {
		t.Fatal(err)
	}
	_ = db.QueryRow(`SELECT COUNT(*) FROM device_backup_buckets`).Scan(&n)
	if n != 1 {
		t.Fatalf("acct_10's bucket was released by acct_1 (%d rows)", n)
	}
}

// A bucket provisioned before the keep-last-version rule existed gets the rule the next time its
// Luna asks for it, once per process, and a failure never blocks the backup.
func TestEnsureDeviceBucketAppliesKeepLastToExistingBucket(t *testing.T) {
	prev := os.Getenv("LUNACONNECT_DEV")
	_ = os.Setenv("LUNACONNECT_DEV", "1")
	t.Cleanup(func() { _ = os.Setenv("LUNACONNECT_DEV", prev) })
	config.C.Server.AtRestKey = ""

	db, err := database.Open(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	sealed, err := security.SealString("old-secret")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO device_backup_buckets (device_id, bucket_name, bucket_id, endpoint, key_id, application_key_sealed, provisioned_at)
VALUES ('acct_1:dev_old', 'luna-backup-old', 'buc-old', 's3.example', 'kid-old', ?, 1)`, sealed); err != nil {
		t.Fatal(err)
	}

	var updates int
	var sentRevision any
	failUpdate := true
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/b2api/v2/b2_authorize_account":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accountId": "acc", "authorizationToken": "tok",
				"apiUrl": "http://" + r.Host, "s3ApiUrl": "https://s3.us-west-001.backblazeb2.com",
			})
		case strings.Contains(r.URL.Path, "b2_list_buckets"):
			_ = json.NewEncoder(w).Encode(map[string]any{"buckets": []map[string]any{
				{"bucketId": "buc-old", "bucketName": "luna-backup-old", "lifecycleRules": []any{}, "revision": 3},
			}})
		case strings.Contains(r.URL.Path, "b2_update_bucket"):
			updates++
			var req map[string]any
			body, _ := io.ReadAll(r.Body)
			_ = json.Unmarshal(body, &req)
			sentRevision = req["ifRevisionIs"]
			assertKeepLastVersionRules(t, req["lifecycleRules"])
			if failUpdate {
				w.WriteHeader(http.StatusServiceUnavailable)
				_, _ = w.Write([]byte(`{"code":"service_unavailable","message":"try later"}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"bucketId": "buc-old", "revision": 4})
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()

	svc := NewService(db)
	if _, err := svc.Create("backup", "B2", map[string]string{
		"account_id": "acc", "application_key": "master",
	}, map[string]string{"bucket_prefix": "luna-backup"}, true); err != nil {
		t.Fatal(err)
	}
	client := NewB2Client(ts.Client())
	client.authorizeURL = ts.URL + "/b2api/v2/b2_authorize_account"
	p := &BucketProvisioner{DB: db, Providers: svc, B2: client}

	// A failed update still hands back the bucket, and is tried again next time.
	got, err := p.EnsureDeviceBucket("acct_1:dev_old")
	if err != nil || got.BucketID != "buc-old" {
		t.Fatalf("got=%+v err=%v", got, err)
	}
	if updates != 1 {
		t.Fatalf("updates=%d, want 1", updates)
	}
	failUpdate = false
	if _, err := p.EnsureDeviceBucket("acct_1:dev_old"); err != nil {
		t.Fatal(err)
	}
	if updates != 2 {
		t.Fatalf("updates=%d, want 2 (retried after the failure)", updates)
	}
	if sentRevision != float64(3) {
		t.Fatalf("ifRevisionIs=%v, want 3", sentRevision)
	}
	// Once it worked, B2 is not asked again.
	if _, err := p.EnsureDeviceBucket("acct_1:dev_old"); err != nil {
		t.Fatal(err)
	}
	if updates != 2 {
		t.Fatalf("updates=%d, want 2 (no more calls once set)", updates)
	}
}
