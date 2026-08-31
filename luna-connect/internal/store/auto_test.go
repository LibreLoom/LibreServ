package store

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

func TestAutoKeepsLocalObjectsAfterB2Enabled(t *testing.T) {
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
	_, _ = db.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, created_at)
VALUES ('acct_1', 'a@example.com', 'x', 1, 'active', 1)`)
	_, _ = db.Exec(`INSERT INTO devices (id, account_id, code_hash, name, subdomain, local_port, created_at)
VALUES ('dev_autotest000001', 'acct_1', 'th', 'Luna', 'den', 8090, 1)`)

	local, err := NewLocal(filepath.Join(dir, "data"))
	if err != nil {
		t.Fatal(err)
	}
	b2, err := NewB2(db, filepath.Join(dir, "tmp"))
	if err != nil {
		t.Fatal(err)
	}
	auto := &Auto{DB: db, Local: local, B2: b2}

	// Before B2 is configured, Put goes to local and we record that.
	n, be, err := auto.Put("acct_1", "dev_autotest000001", "old.txt", strings.NewReader("local-bytes"))
	if err != nil || n != 11 || be != BackendLocal {
		t.Fatalf("local put: n=%d be=%q err=%v", n, be, err)
	}
	_, _ = db.Exec(`INSERT INTO backup_objects (id, account_id, device_id, relative_path, size, content_hash, storage_backend, updated_at)
VALUES ('obj_old', 'acct_1', 'dev_autotest000001', 'old.txt', 11, 'h', ?, ?)`, BackendLocal, time.Now().Unix())

	objects := map[string][]byte{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/b2api/v2/b2_authorize_account":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accountId": "acc", "authorizationToken": "tok",
				"apiUrl": "http://" + r.Host, "downloadUrl": "http://" + r.Host,
				"s3ApiUrl": "https://s3.us-west-001.backblazeb2.com",
			})
		case strings.Contains(r.URL.Path, "b2_create_bucket"):
			_ = json.NewEncoder(w).Encode(map[string]string{"bucketId": "buc1", "bucketName": "luna-backup-dev-autotest000001"})
		case strings.Contains(r.URL.Path, "b2_create_key"):
			_ = json.NewEncoder(w).Encode(map[string]string{"applicationKeyId": "kid", "applicationKey": "ksecret"})
		case strings.Contains(r.URL.Path, "b2_get_upload_url"):
			_ = json.NewEncoder(w).Encode(map[string]string{
				"bucketId": "buc1", "uploadUrl": "http://" + r.Host + "/upload", "authorizationToken": "up-tok",
			})
		case r.URL.Path == "/upload":
			body, _ := io.ReadAll(r.Body)
			objects[r.Header.Get("X-Bz-File-Name")] = body
			_ = json.NewEncoder(w).Encode(map[string]string{"fileId": "f1", "fileName": r.Header.Get("X-Bz-File-Name")})
		case strings.HasPrefix(r.URL.Path, "/file/"):
			parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/file/"), "/", 2)
			if len(parts) != 2 {
				http.NotFound(w, r)
				return
			}
			data, ok := objects[parts[1]]
			if !ok {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write(data)
		case strings.Contains(r.URL.Path, "b2_list_file_versions"):
			var files []map[string]string
			for name := range objects {
				files = append(files, map[string]string{"fileId": "f-" + name, "fileName": name})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"files": files})
		case strings.Contains(r.URL.Path, "b2_delete_file_version"):
			var req map[string]string
			_ = json.NewDecoder(r.Body).Decode(&req)
			delete(objects, req["fileName"])
			_, _ = w.Write([]byte("{}"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()

	client := providers.NewB2Client(ts.Client())
	providers.SetAuthorizeURLForTest(client, ts.URL+"/b2api/v2/b2_authorize_account")
	b2.Client = client
	b2.Provisioner.B2 = client

	svc := providers.NewService(db)
	_, err = svc.Create("backup", "B2", map[string]string{
		"account_id": "acc", "application_key": "master",
	}, map[string]string{"bucket_prefix": "luna-backup"}, true)
	if err != nil {
		t.Fatal(err)
	}

	// New Put goes to B2 while old local object remains readable.
	n, be, err = auto.Put("acct_1", "dev_autotest000001", "new.txt", strings.NewReader("b2-bytes"))
	if err != nil || n != 8 || be != BackendB2 {
		t.Fatalf("b2 put: n=%d be=%q err=%v", n, be, err)
	}
	_, _ = db.Exec(`INSERT INTO backup_objects (id, account_id, device_id, relative_path, size, content_hash, storage_backend, updated_at)
VALUES ('obj_new', 'acct_1', 'dev_autotest000001', 'new.txt', 8, 'h2', ?, ?)`, BackendB2, time.Now().Unix())

	rc, err := auto.Get("acct_1", "dev_autotest000001", "old.txt")
	if err != nil {
		t.Fatalf("get old local after B2 enabled: %v", err)
	}
	got, _ := io.ReadAll(rc)
	_ = rc.Close()
	if !bytes.Equal(got, []byte("local-bytes")) {
		t.Fatalf("old object corrupted: %q", got)
	}

	rc, err = auto.Get("acct_1", "dev_autotest000001", "new.txt")
	if err != nil {
		t.Fatalf("get new b2: %v", err)
	}
	got, _ = io.ReadAll(rc)
	_ = rc.Close()
	if !bytes.Equal(got, []byte("b2-bytes")) {
		t.Fatalf("new object: %q", got)
	}

	// Disabling B2 must not strand B2-backed objects.
	_ = svc.Update(mustProviderID(t, db), "backup", "B2", map[string]string{
		"account_id": "acc", "application_key": "master",
	}, map[string]string{"bucket_prefix": "luna-backup"}, false)

	rc, err = auto.Get("acct_1", "dev_autotest000001", "new.txt")
	if err != nil {
		t.Fatalf("get b2 object after provider disabled: %v", err)
	}
	got, _ = io.ReadAll(rc)
	_ = rc.Close()
	if !bytes.Equal(got, []byte("b2-bytes")) {
		t.Fatalf("b2 object after disable: %q", got)
	}

	if err := auto.Delete("acct_1", "dev_autotest000001", "old.txt"); err != nil {
		t.Fatal(err)
	}
	if _, err := local.Get("acct_1", "dev_autotest000001", "old.txt"); !os.IsNotExist(err) {
		t.Fatalf("expected local deleted, err=%v", err)
	}
}

func TestAutoOverwriteMigratesOffOldBackend(t *testing.T) {
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
	_, _ = db.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, created_at)
VALUES ('acct_1', 'a@example.com', 'x', 1, 'active', 1)`)
	_, _ = db.Exec(`INSERT INTO devices (id, account_id, code_hash, name, subdomain, local_port, created_at)
VALUES ('dev_migrate0000001', 'acct_1', 'th', 'Luna', 'den', 8090, 1)`)

	local, err := NewLocal(filepath.Join(dir, "data"))
	if err != nil {
		t.Fatal(err)
	}
	objects := map[string][]byte{}
	ts := httptest.NewServer(b2TestHandler(objects))
	defer ts.Close()

	b2, err := NewB2(db, filepath.Join(dir, "tmp"))
	if err != nil {
		t.Fatal(err)
	}
	client := providers.NewB2Client(ts.Client())
	providers.SetAuthorizeURLForTest(client, ts.URL+"/b2api/v2/b2_authorize_account")
	b2.Client = client
	b2.Provisioner.B2 = client

	auto := &Auto{DB: db, Local: local, B2: b2}
	_, be, err := auto.Put("acct_1", "dev_migrate0000001", "same.txt", strings.NewReader("v1"))
	if err != nil || be != BackendLocal {
		t.Fatalf("first put: be=%q err=%v", be, err)
	}
	_, _ = db.Exec(`INSERT INTO backup_objects (id, account_id, device_id, relative_path, size, content_hash, storage_backend, updated_at)
VALUES ('obj1', 'acct_1', 'dev_migrate0000001', 'same.txt', 2, 'h', 'local', 1)`)

	svc := providers.NewService(db)
	_, err = svc.Create("backup", "B2", map[string]string{
		"account_id": "acc", "application_key": "master",
	}, map[string]string{"bucket_prefix": "luna-backup"}, true)
	if err != nil {
		t.Fatal(err)
	}

	_, be, err = auto.Put("acct_1", "dev_migrate0000001", "same.txt", strings.NewReader("v2-longer"))
	if err != nil || be != BackendB2 {
		t.Fatalf("migrate put: be=%q err=%v", be, err)
	}
	if _, err := local.Get("acct_1", "dev_migrate0000001", "same.txt"); !os.IsNotExist(err) {
		t.Fatalf("expected old local removed after migrate, err=%v", err)
	}
	rc, err := auto.Get("acct_1", "dev_migrate0000001", "same.txt")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(rc)
	_ = rc.Close()
	if !bytes.Equal(got, []byte("v2-longer")) {
		t.Fatalf("got %q", got)
	}
}

func b2TestHandler(objects map[string][]byte) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/b2api/v2/b2_authorize_account":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accountId": "acc", "authorizationToken": "tok",
				"apiUrl": "http://" + r.Host, "downloadUrl": "http://" + r.Host,
				"s3ApiUrl": "https://s3.us-west-001.backblazeb2.com",
			})
		case strings.Contains(r.URL.Path, "b2_create_bucket"):
			_ = json.NewEncoder(w).Encode(map[string]string{"bucketId": "buc1", "bucketName": "luna-backup-dev"})
		case strings.Contains(r.URL.Path, "b2_create_key"):
			_ = json.NewEncoder(w).Encode(map[string]string{"applicationKeyId": "kid", "applicationKey": "ksecret"})
		case strings.Contains(r.URL.Path, "b2_get_upload_url"):
			_ = json.NewEncoder(w).Encode(map[string]string{
				"bucketId": "buc1", "uploadUrl": "http://" + r.Host + "/upload", "authorizationToken": "up-tok",
			})
		case r.URL.Path == "/upload":
			body, _ := io.ReadAll(r.Body)
			objects[r.Header.Get("X-Bz-File-Name")] = body
			_ = json.NewEncoder(w).Encode(map[string]string{"fileId": "f1", "fileName": r.Header.Get("X-Bz-File-Name")})
		case strings.HasPrefix(r.URL.Path, "/file/"):
			parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/file/"), "/", 2)
			if len(parts) != 2 {
				http.NotFound(w, r)
				return
			}
			data, ok := objects[parts[1]]
			if !ok {
				http.NotFound(w, r)
				return
			}
			_, _ = w.Write(data)
		case strings.Contains(r.URL.Path, "b2_list_file_versions"):
			var files []map[string]string
			for name := range objects {
				files = append(files, map[string]string{"fileId": "f-" + name, "fileName": name})
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"files": files})
		case strings.Contains(r.URL.Path, "b2_delete_file_version"):
			var req map[string]string
			_ = json.NewDecoder(r.Body).Decode(&req)
			delete(objects, req["fileName"])
			_, _ = w.Write([]byte("{}"))
		default:
			http.NotFound(w, r)
		}
	}
}

func mustProviderID(t *testing.T, db *sql.DB) string {
	t.Helper()
	var id string
	if err := db.QueryRow(`SELECT id FROM service_providers WHERE service = 'backup' LIMIT 1`).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}
