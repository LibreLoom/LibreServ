package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func TestAdminDevicesPagination(t *testing.T) {
	d := testDeps(t)
	h := AdminConsoleHandler{Deps: d}
	now := time.Now().Unix()
	for i := 0; i < 3; i++ {
		_, _, err := insertPermanentDevice(d.DB, "official", security.OfficialDeviceToken(), "")
		if err != nil {
			t.Fatal(err)
		}
	}
	_, _ = d.DB.Exec(`UPDATE devices SET created_at = ?`, now)

	req := httptest.NewRequest(http.MethodGet, "/admin/devices?limit=2&offset=0", nil)
	rec := httptest.NewRecorder()
	h.Devices(rec, req)
	if rec.Code != 200 {
		t.Fatalf("devices %d %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	devices := body["devices"].([]any)
	if len(devices) != 2 {
		t.Fatalf("devices len=%d", len(devices))
	}
	page := body["pagination"].(map[string]any)
	if page["has_more"] != true {
		t.Fatalf("pagination=%v", page)
	}
}

func TestBackupListPagination(t *testing.T) {
	d := testDeps(t)
	h := BackupHandler{Deps: d}
	now := time.Now().Unix()
	_, _ = d.DB.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES ('acct_pg', 'pg@b.co', 'x', 1, 'active', 1, ?)`, now)
	for i := 0; i < 3; i++ {
		_, _ = d.DB.Exec(`INSERT INTO backup_objects (id, account_id, device_id, relative_path, size, content_hash, storage_backend, updated_at)
VALUES (?, 'acct_pg', 'dev1', ?, 1, 'h', 'local', ?)`, security.NewID("obj"), "path-"+itoa(i), now)
	}

	req := httptest.NewRequest(http.MethodGet, "/backups?limit=2&offset=0", nil)
	req = req.WithContext(WithAccount(req.Context(), Account{ID: "acct_pg", Email: "pg@b.co"}))
	rec := httptest.NewRecorder()
	h.List(rec, req)
	if rec.Code != 200 {
		t.Fatalf("list %d %s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	_ = json.Unmarshal(rec.Body.Bytes(), &body)
	objs := body["objects"].([]any)
	if len(objs) != 2 {
		t.Fatalf("objects len=%d", len(objs))
	}
}

func TestStatusDebouncesLastSeen(t *testing.T) {
	d := testDeps(t)
	h := DeviceHandler{Deps: d}
	now := time.Now().Unix()
	_, _ = d.DB.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES ('acct_seen', 'seen@b.co', 'x', 1, 'active', 1, ?)`, now)
	id, _, err := insertPermanentDevice(d.DB, "official", security.OfficialDeviceToken(), "")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = d.DB.Exec(`UPDATE devices SET account_id = 'acct_seen', last_seen_at = ? WHERE id = ?`, now, id)

	dev := Device{ID: id, AccountID: sql.NullString{String: "acct_seen", Valid: true}}
	req := httptest.NewRequest(http.MethodGet, "/status", nil)
	req = req.WithContext(WithDevice(req.Context(), dev))
	rec := httptest.NewRecorder()
	h.Status(rec, req)
	if rec.Code != 200 {
		t.Fatalf("status %d %s", rec.Code, rec.Body.String())
	}
	var seen int64
	_ = d.DB.QueryRow(`SELECT last_seen_at FROM devices WHERE id = ?`, id).Scan(&seen)
	if seen != now {
		t.Fatalf("last_seen_at changed from %d to %d", now, seen)
	}
}
