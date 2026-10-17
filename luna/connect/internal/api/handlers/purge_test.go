package handlers

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func TestPurgeDeviceCodeBoundDevice(t *testing.T) {
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
	_, _ = d.DB.Exec(`INSERT INTO luna_ids (account_id, luna_id, device_id, signing_public, purge_after, created_at) VALUES ('acct_purge', 'luna-purge', ?, '', 0, ?)`, devID, now)
	_, _ = d.DB.Exec(`INSERT INTO storage_packs (account_id, luna_id, id, scope, size, created_at, storage_backend) VALUES ('acct_purge', 'luna-purge', ?, '', 42, ?, 'local')`, strings.Repeat("a", 64), now)
	_, _ = d.DB.Exec(`INSERT INTO device_backup_buckets (device_id, bucket_name, bucket_id, endpoint, key_id, application_key_sealed, provisioned_at)
VALUES (?, 'bucket-test', 'bid', 'https://b2.example', 'kid', 'sealed', ?)`, devID, now)

	req := httptest.NewRequest(http.MethodPost, "/admin/device-codes/"+devID+"/purge", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("codeID", devID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	h.PurgeDeviceCode(rec, req)
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
	if bucketCount != 1 {
		t.Fatal("bucket mapping must survive purge so kept backup objects stay reachable")
	}

	// The Luna's storage is kept for 30 days; its purge is scheduled, not run now.
	var purgeAfter int64
	_ = d.DB.QueryRow(`SELECT purge_after FROM luna_ids WHERE account_id = 'acct_purge' AND luna_id = 'luna-purge'`).Scan(&purgeAfter)
	if purgeAfter < now+29*86400 || purgeAfter > now+31*86400 {
		t.Fatalf("purge_after %d, want about 30 days from now", purgeAfter)
	}
	var packCount int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM storage_packs WHERE account_id = 'acct_purge' AND luna_id = 'luna-purge'`).Scan(&packCount)
	if packCount != 1 {
		t.Fatal("storage must be kept until the 30 days are up")
	}

	stReq := httptest.NewRequest(http.MethodGet, "/status", nil)
	stReq.Header.Set("Authorization", "Bearer "+code)
	stRec := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(devH.Status)).ServeHTTP(stRec, stReq)
	if stRec.Code != http.StatusUnauthorized {
		t.Fatalf("token should not auth after purge, got %d", stRec.Code)
	}
}

func TestPurgeDeviceCodeUnboundRevokesInsteadOfConflict(t *testing.T) {
	d := testDeps(t)
	h := AdminConsoleHandler{Deps: d}
	devID, code, err := insertPermanentDevice(d.DB, "official", security.OfficialDeviceToken(), "")
	if err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/admin/device-codes/"+devID+"/purge", nil)
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add("codeID", devID)
	req = req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
	rec := httptest.NewRecorder()
	h.PurgeDeviceCode(rec, req)
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

func TestDeleteAccountRemovesStorage(t *testing.T) {
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
	_, _ = d.DB.Exec(`INSERT INTO luna_ids (account_id, luna_id, device_id, signing_public, purge_after, created_at) VALUES ('acct_del', 'luna-del', ?, '', 0, ?)`, devID, now)
	_, _ = d.DB.Exec(`INSERT INTO storage_packs (account_id, luna_id, id, scope, size, created_at, storage_backend) VALUES ('acct_del', 'luna-del', ?, '', 9, ?, 'local')`, strings.Repeat("b", 64), now)

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

	var packCount int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM storage_packs WHERE account_id = 'acct_del'`).Scan(&packCount)
	if packCount != 0 {
		t.Fatal("storage packs should be deleted with the account")
	}
}

// Linking a Luna again (any storage call by its owning device) cancels its pending purge.
func TestStorageCallClearsPendingLunaPurge(t *testing.T) {
	h, d, tok := storageFixture(t, "relink", 0)
	now := time.Now().Unix()
	var acctID string
	_ = d.DB.QueryRow(`SELECT account_id FROM devices WHERE id = 'dev_relink'`).Scan(&acctID)
	_, _ = d.DB.Exec(`INSERT INTO luna_ids (account_id, luna_id, device_id, signing_public, purge_after, created_at) VALUES (?, 'luna1', 'dev_relink', '', ?, ?)`,
		acctID, now+86400, now)

	rec := storageDo(t, h, http.MethodGet, "/records/notes", tok, "luna1", nil, nil)
	if rec.Code == http.StatusUnauthorized || rec.Code == http.StatusForbidden {
		t.Fatalf("owner call refused %d %s", rec.Code, rec.Body.String())
	}
	var purgeAfter int64
	_ = d.DB.QueryRow(`SELECT purge_after FROM luna_ids WHERE account_id = ? AND luna_id = 'luna1'`, acctID).Scan(&purgeAfter)
	if purgeAfter != 0 {
		t.Fatalf("purge_after %d after the Luna was used again, want 0", purgeAfter)
	}
}
