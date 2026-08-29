package store

import (
	"bytes"
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
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

func TestB2StorePutGetDelete(t *testing.T) {
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
	_, _ = db.Exec(`INSERT INTO devices (id, account_id, token_hash, name, subdomain, local_port, created_at)
VALUES ('dev_storetest0001', 'acct_1', 'th', 'Luna', 'den', 8090, 1)`)

	objects := map[string][]byte{}
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/b2api/v2/b2_authorize_account":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accountId":          "acc",
				"authorizationToken": "tok",
				"apiUrl":             "http://" + r.Host,
				"downloadUrl":        "http://" + r.Host,
				"s3ApiUrl":           "https://s3.us-west-001.backblazeb2.com",
			})
		case strings.Contains(r.URL.Path, "b2_create_bucket"):
			_ = json.NewEncoder(w).Encode(map[string]string{"bucketId": "buc1", "bucketName": "luna-backup-dev-storetest0001"})
		case strings.Contains(r.URL.Path, "b2_create_key"):
			_ = json.NewEncoder(w).Encode(map[string]string{"applicationKeyId": "kid", "applicationKey": "ksecret"})
		case strings.Contains(r.URL.Path, "b2_get_upload_url"):
			_ = json.NewEncoder(w).Encode(map[string]string{
				"bucketId": "buc1", "uploadUrl": "http://" + r.Host + "/upload", "authorizationToken": "up-tok",
			})
		case r.URL.Path == "/upload":
			body, _ := io.ReadAll(r.Body)
			name := r.Header.Get("X-Bz-File-Name")
			objects[name] = body
			w.WriteHeader(http.StatusOK)
			_ = json.NewEncoder(w).Encode(map[string]string{"fileId": "f1", "fileName": name})
		case strings.HasPrefix(r.URL.Path, "/file/"):
			// /file/{bucket}/{key...}
			parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/file/"), "/", 2)
			if len(parts) != 2 {
				http.NotFound(w, r)
				return
			}
			key := parts[1]
			data, ok := objects[key]
			if !ok {
				// try percent-decoded form used by PathEscape
				for k, v := range objects {
					if k == key || strings.ReplaceAll(k, "%2F", "/") == key {
						data, ok = v, true
						break
					}
				}
			}
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
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write([]byte("{}"))
		default:
			http.NotFound(w, r)
		}
	}))
	defer ts.Close()

	svc := providers.NewService(db)
	_, err = svc.Create("backup", "B2", map[string]string{
		"account_id": "acc", "application_key": "master",
	}, map[string]string{"bucket_prefix": "luna-backup"}, true)
	if err != nil {
		t.Fatal(err)
	}

	client := providers.NewB2Client(ts.Client())
	// authorizeURL is unexported — set via provision path using same client pattern in store.
	// Use NewB2 then swap client authorize by wrapping through provisioner.
	st, err := NewB2(db, filepath.Join(dir, "tmp"))
	if err != nil {
		t.Fatal(err)
	}
	st.Client = client
	st.Provisioner.B2 = client
	providers.SetAuthorizeURLForTest(client, ts.URL+"/b2api/v2/b2_authorize_account")

	n, be, err := st.Put("acct_1", "dev_storetest0001", "Photos/a.jpg", strings.NewReader("hello"))
	if err != nil || n != 5 || be != BackendB2 {
		t.Fatalf("put %d be=%q %v", n, be, err)
	}
	rc, err := st.Get("acct_1", "dev_storetest0001", "Photos/a.jpg")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(rc)
	_ = rc.Close()
	if !bytes.Equal(got, []byte("hello")) {
		t.Fatalf("got %q", got)
	}
	if err := st.Delete("acct_1", "dev_storetest0001", "Photos/a.jpg"); err != nil {
		t.Fatal(err)
	}
}

func TestOpenAutoUsesLocalWithoutProvider(t *testing.T) {
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	st, name, err := Open(db, "auto", filepath.Join(dir, "data"))
	if err != nil {
		t.Fatal(err)
	}
	if name != "auto" {
		t.Fatalf("driver=%s", name)
	}
	if _, ok := st.(*Auto); !ok {
		t.Fatalf("type %T", st)
	}
	n, be, err := st.Put("acct_1", "dev_1", "f.txt", strings.NewReader("x"))
	if err != nil || n != 1 || be != BackendLocal {
		t.Fatalf("local put via auto: %d be=%q %v", n, be, err)
	}
}
