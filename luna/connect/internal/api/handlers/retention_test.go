package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/mail"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

func TestCancelSetsPurgeAndReattachClears(t *testing.T) {
	_, acct, _ := testOnboarding(t)
	recMail := &mail.Recording{}
	acct.Mail = recMail
	cookie := registerAccount(t, acct, "pay@b.co")
	var id string
	_ = acct.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'pay@b.co'`).Scan(&id)
	_, _ = acct.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'dev', stripe_subscription_id = 'sub_dev' WHERE id = ?`, id)

	req := httptest.NewRequest(http.MethodPost, "/billing/cancel", nil)
	req.AddCookie(cookie)
	rec := withAccount(acct, acct.CancelBilling, req)
	if rec.Code != 200 {
		t.Fatalf("cancel %d %s", rec.Code, rec.Body.String())
	}
	var has int
	var status string
	var purge, mailDay int64
	_ = acct.DB.QueryRow(`SELECT has_card, billing_status, COALESCE(backup_purge_after,0), COALESCE(purge_mail_day,-2) FROM accounts WHERE id = ?`, id).
		Scan(&has, &status, &purge, &mailDay)
	if has != 0 || status != "canceled" {
		t.Fatalf("has=%d status=%s", has, status)
	}
	now := time.Now().Unix()
	if purge < now+29*86400 || purge > now+31*86400 {
		t.Fatalf("purge %d", purge)
	}
	if mailDay != 0 {
		t.Fatalf("mail day %d", mailDay)
	}
	if len(recMail.Sends) != 1 || recMail.Sends[0][0] != "pay@b.co" {
		t.Fatalf("mail %+v", recMail.Sends)
	}
	if !strings.Contains(recMail.Sends[0][1], "have your files") || !strings.Contains(recMail.Sends[0][2], "download") {
		t.Fatalf("warning should ask them to keep their files: %+v", recMail.Sends)
	}
	if strings.Contains(strings.ToLower(recMail.Sends[0][2]), "add a payment card") {
		t.Fatalf("warning should not pitch a card: %+v", recMail.Sends)
	}

	attach := httptest.NewRequest(http.MethodPost, "/billing/attach-card", strings.NewReader("{}"))
	attach.AddCookie(cookie)
	arec := withAccount(acct, acct.AttachCard, attach)
	if arec.Code != 200 {
		t.Fatalf("attach %d %s", arec.Code, arec.Body.String())
	}
	_ = acct.DB.QueryRow(`SELECT COALESCE(backup_purge_after,0), COALESCE(purge_mail_day,-2) FROM accounts WHERE id = ?`, id).Scan(&purge, &mailDay)
	if purge != 0 {
		t.Fatalf("purge still set %d", purge)
	}
}

func TestRetentionDeletesAfterDeadline(t *testing.T) {
	d := testDeps(t)
	recMail := &mail.Recording{}
	d.Mail = recMail
	_, acct, _ := testOnboarding(t)
	acct.Deps = d
	_ = registerAccount(t, acct, "gone@b.co")
	var id string
	_ = d.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'gone@b.co'`).Scan(&id)
	packID := strings.Repeat("c", 64)
	seedLunaWithPack(t, d, id, "luna-t", "dev_old1", 0, packID)
	now := time.Now().Unix()
	_, _ = d.DB.Exec(`UPDATE accounts SET backup_purge_after = ?, purge_mail_day = 27 WHERE id = ?`, now-1, id)

	ProcessRetention(d, now)
	if n := countRows(t, d, `SELECT COUNT(*) FROM storage_packs WHERE account_id = ?`, id); n != 0 {
		t.Fatalf("packs left %d", n)
	}
	if _, err := d.Store.Get(id, store.StorageSlot("luna-t"), store.StoragePackPath(packID)); err == nil {
		t.Fatal("store file should be gone")
	}
	if len(recMail.Sends) != 1 || !strings.Contains(recMail.Sends[0][1], "were deleted") {
		t.Fatalf("gone mail %+v", recMail.Sends)
	}
}

func TestRetentionWarningDaysDoNotDoubleSend(t *testing.T) {
	d := testDeps(t)
	recMail := &mail.Recording{}
	d.Mail = recMail
	_, acct, _ := testOnboarding(t)
	acct.Deps = d
	_ = registerAccount(t, acct, "warn@b.co")
	var id string
	_ = d.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'warn@b.co'`).Scan(&id)
	start := time.Now().Unix()
	deadline := start + 30*86400
	_, _ = d.DB.Exec(`UPDATE accounts SET backup_purge_after = ?, purge_mail_day = -1 WHERE id = ?`, deadline, id)

	ProcessRetention(d, start)
	ProcessRetention(d, start)
	if len(recMail.Sends) != 1 {
		t.Fatalf("day0 sends %d", len(recMail.Sends))
	}
	ProcessRetention(d, start+3*86400)
	if len(recMail.Sends) != 2 {
		t.Fatalf("day3 sends %d", len(recMail.Sends))
	}
	ProcessRetention(d, start+4*86400)
	if len(recMail.Sends) != 2 {
		t.Fatalf("day4 extra send %d", len(recMail.Sends))
	}
}

// seedLunaWithPack gives an account one Luna: its luna_ids row, one storage pack row and the pack's blob.
func seedLunaWithPack(t *testing.T, d Deps, acctID, lunaID, deviceID string, purgeAfter int64, packID string) {
	t.Helper()
	now := time.Now().Unix()
	if _, err := d.DB.Exec(`INSERT INTO luna_ids (account_id, luna_id, device_id, signing_public, purge_after, created_at) VALUES (?, ?, ?, '', ?, ?)`,
		acctID, lunaID, deviceID, purgeAfter, now); err != nil {
		t.Fatal(err)
	}
	if _, err := d.DB.Exec(`INSERT INTO storage_packs (account_id, luna_id, id, scope, size, created_at, storage_backend) VALUES (?, ?, ?, '', 5, ?, 'local')`,
		acctID, lunaID, packID, now); err != nil {
		t.Fatal(err)
	}
	if _, _, err := d.Store.Put(acctID, store.StorageSlot(lunaID), store.StoragePackPath(packID), strings.NewReader("bytes")); err != nil {
		t.Fatal(err)
	}
}

// countRows runs a COUNT(*) query and returns the number it finds.
func countRows(t *testing.T, d Deps, query string, args ...any) int {
	t.Helper()
	var n int
	if err := d.DB.QueryRow(query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func TestRetentionPurgesOnlyUnlinkedLuna(t *testing.T) {
	d := testDeps(t)
	_, acct, _ := testOnboarding(t)
	acct.Deps = d
	_ = registerAccount(t, acct, "unlink@b.co")
	var id string
	_ = d.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'unlink@b.co'`).Scan(&id)
	now := time.Now().Unix()
	seedLunaWithPack(t, d, id, "luna-gone", "dev_gone", now-1, strings.Repeat("d", 64))
	seedLunaWithPack(t, d, id, "luna-kept", "dev_kept", 0, strings.Repeat("e", 64))

	ProcessRetention(d, now)

	if n := countRows(t, d, `SELECT COUNT(*) FROM storage_packs WHERE account_id = ? AND luna_id = 'luna-gone'`, id); n != 0 {
		t.Fatalf("unlinked luna packs left %d", n)
	}
	if n := countRows(t, d, `SELECT COUNT(*) FROM luna_ids WHERE account_id = ? AND luna_id = 'luna-gone'`, id); n != 0 {
		t.Fatalf("unlinked luna row left %d", n)
	}
	if n := countRows(t, d, `SELECT COUNT(*) FROM storage_packs WHERE account_id = ? AND luna_id = 'luna-kept'`, id); n != 1 {
		t.Fatalf("linked luna packs %d want 1", n)
	}
	if n := countRows(t, d, `SELECT COUNT(*) FROM luna_ids WHERE account_id = ? AND luna_id = 'luna-kept'`, id); n != 1 {
		t.Fatalf("linked luna row %d want 1", n)
	}
}

func TestRetentionKeepsLunaWithFuturePurge(t *testing.T) {
	d := testDeps(t)
	_, acct, _ := testOnboarding(t)
	acct.Deps = d
	_ = registerAccount(t, acct, "later@b.co")
	var id string
	_ = d.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'later@b.co'`).Scan(&id)
	now := time.Now().Unix()
	packID := strings.Repeat("f", 64)
	seedLunaWithPack(t, d, id, "luna-later", "dev_later", now+86400, packID)

	ProcessRetention(d, now)

	if n := countRows(t, d, `SELECT COUNT(*) FROM storage_packs WHERE account_id = ? AND luna_id = 'luna-later'`, id); n != 1 {
		t.Fatalf("pending luna packs %d want 1", n)
	}
	if n := countRows(t, d, `SELECT COUNT(*) FROM luna_ids WHERE account_id = ? AND luna_id = 'luna-later'`, id); n != 1 {
		t.Fatalf("pending luna row %d want 1", n)
	}
	if _, err := d.Store.Get(id, store.StorageSlot("luna-later"), store.StoragePackPath(packID)); err != nil {
		t.Fatalf("pending luna blob should stay: %v", err)
	}
}

func TestShouldSendWarningSchedule(t *testing.T) {
	if !shouldSendWarning(0, -1) || !shouldSendWarning(3, 0) || shouldSendWarning(4, 3) || shouldSendWarning(3, 3) {
		t.Fatal("schedule")
	}
}

func TestPurgeMailAsksForDataNotACard(t *testing.T) {
	subj, body := purgeMail(0)
	if !strings.Contains(subj, "have your files") || !strings.Contains(body, "download") || strings.Contains(strings.ToLower(body), "payment card") {
		t.Fatalf("day0 %q %q", subj, body)
	}
	subj, body = purgeMail(27)
	if !strings.Contains(body, "3 days") || strings.Contains(strings.ToLower(body), "payment card") {
		t.Fatalf("day27 %q %q", subj, body)
	}
	subj, body = purgeMail(30)
	if !strings.Contains(subj, "were deleted") {
		t.Fatalf("day30 %q %q", subj, body)
	}
}
