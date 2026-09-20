package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func TestPurgeSetupTokenBoundDevice(t *testing.T) {
	d := testDeps(t)
	h := AdminConsoleHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	now := time.Now().Unix()

	_, _ = d.DB.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES ('acct_purge', 'purge@b.co', 'x', 0, 'none', 1, ?)`, now)

	devID, code, err := insertPermanentDevice(d.DB, "official", security.OfficialDeviceToken(), "order-purge")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = d.DB.Exec(`UPDATE devices SET account_id = 'acct_purge', subdomain = 'purgebox', tunnel_id = 'tnl_test' WHERE id = ?`, devID)
	_, _ = d.DB.Exec(`INSERT INTO backup_bindings (id, account_id, device_id, status, created_at) VALUES ('bb_1', 'acct_purge', ?, 'active', ?)`, devID, now)
	_, _ = d.DB.Exec(`INSERT INTO backup_objects (id, account_id, device_id, relative_path, size, updated_at) VALUES ('bo_1', 'acct_purge', ?, 'Photos/a.jpg', 42, ?)`, devID, now)
	_, _ = d.DB.Exec(`INSERT INTO device_backup_buckets (device_id, bucket_name, bucket_id, endpoint, key_id, application_key_sealed, provisioned_at)
VALUES (?, 'bucket-test', 'bid', 'https://b2.example', 'kid', 'sealed', ?)`, devID, now)

	req := httptest.NewRequest(http.MethodPost, "/admin/setup-tokens/"+devID+"/purge", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("tokenID", devID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	h.PurgeSetupToken(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("purge %d %s", rec.Code, rec.Body.String())
	}

	var devCount int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM devices WHERE id = ?`, devID).Scan(&devCount)
	if devCount != 0 {
		t.Fatal("device row should be deleted")
	}

	var bucketCount int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM device_backup_buckets WHERE device_id = ?`, devID).Scan(&bucketCount)
	if bucketCount != 0 {
		t.Fatal("device backup bucket mapping should be removed")
	}

	var objCount int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM backup_objects WHERE id = 'bo_1'`).Scan(&objCount)
	if objCount != 1 {
		t.Fatal("backup objects must be kept")
	}

	var bindingStatus string
	_ = d.DB.QueryRow(`SELECT status FROM backup_bindings WHERE id = 'bb_1'`).Scan(&bindingStatus)
	if bindingStatus != "archived" {
		t.Fatalf("binding status %q want archived", bindingStatus)
	}

	stReq := httptest.NewRequest(http.MethodGet, "/status", nil)
	stReq.Header.Set("Authorization", "Bearer "+code)
	stRec := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(devH.Status)).ServeHTTP(stRec, stReq)
	if stRec.Code != http.StatusUnauthorized {
		t.Fatalf("token should not auth after purge, got %d", stRec.Code)
	}
}

func TestPurgeSetupTokenUnboundRevokesInsteadOfConflict(t *testing.T) {
	d := testDeps(t)
	h := AdminConsoleHandler{Deps: d}
	devID, code, err := insertPermanentDevice(d.DB, "official", security.OfficialDeviceToken(), "")
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/admin/setup-tokens/"+devID+"/purge", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("tokenID", devID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	h.PurgeSetupToken(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("purge unbound %d %s", rec.Code, rec.Body.String())
	}

	var count int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM devices WHERE id = ?`, devID).Scan(&count)
	if count != 0 {
		t.Fatal("unbound token row should be deleted")
	}
	_ = code
}

func TestDeleteAccountKeepsBackups(t *testing.T) {
	d := testDeps(t)
	h := AdminConsoleHandler{Deps: d}
	now := time.Now().Unix()

	_, _ = d.DB.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, email_verified, created_at)
VALUES ('acct_del', 'del@b.co', 'x', 0, 'none', 1, ?)`, now)
	_, _ = d.DB.Exec(`INSERT INTO sessions (token_hash, account_id, expires_at) VALUES ('hash1', 'acct_del', ?)`, now+3600)
	_, _ = d.DB.Exec(`INSERT INTO billing_storage_samples (account_id, period_ym, sampled_at, stored_bytes) VALUES ('acct_del', '2026-01', ?, 100)`, now)

	devID, _, err := insertPermanentDevice(d.DB, "official", security.OfficialDeviceToken(), "")
	if err != nil {
		t.Fatal(err)
	}
	_, _ = d.DB.Exec(`UPDATE devices SET account_id = 'acct_del' WHERE id = ?`, devID)
	_, _ = d.DB.Exec(`INSERT INTO backup_objects (id, account_id, device_id, relative_path, size, updated_at) VALUES ('bo_del', 'acct_del', ?, 'Docs/x.txt', 9, ?)`, devID, now)

	req := httptest.NewRequest(http.MethodDelete, "/admin/accounts/acct_del", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("accountID", "acct_del")
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	h.DeleteAccount(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("delete account %d %s", rec.Code, rec.Body.String())
	}

	var acctCount int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM accounts WHERE id = 'acct_del'`).Scan(&acctCount)
	if acctCount != 0 {
		t.Fatal("account should be deleted")
	}

	var sessCount int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM sessions WHERE account_id = 'acct_del'`).Scan(&sessCount)
	if sessCount != 0 {
		t.Fatal("sessions should be deleted")
	}

	var sampleCount int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM billing_storage_samples WHERE account_id = 'acct_del'`).Scan(&sampleCount)
	if sampleCount != 0 {
		t.Fatal("billing samples should be deleted")
	}

	var objCount int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM backup_objects WHERE id = 'bo_del'`).Scan(&objCount)
	if objCount != 1 {
		t.Fatal("backup objects must remain after account delete")
	}
}
