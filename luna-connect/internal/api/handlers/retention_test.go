package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/mail"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
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
	if _, err := d.Store.Put(id, "dev_old1", "keep.txt", strings.NewReader("bytes")); err != nil {
		t.Fatal(err)
	}
	_, _ = d.DB.Exec(`INSERT INTO backup_objects (id, account_id, device_id, relative_path, size, content_hash, updated_at)
VALUES ('obj_g', ?, 'dev_old1', 'keep.txt', 5, 'h', ?)`, id, time.Now().Unix())
	now := time.Now().Unix()
	_, _ = d.DB.Exec(`UPDATE accounts SET backup_purge_after = ?, purge_mail_day = 27 WHERE id = ?`, now-1, id)

	ProcessRetention(d, now)
	var n int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM backup_objects WHERE account_id = ?`, id).Scan(&n)
	if n != 0 {
		t.Fatalf("objects left %d", n)
	}
	if _, err := d.Store.Get(id, "dev_old1", "keep.txt"); err == nil {
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

func TestBackupDownloadAfterDeviceDeleted(t *testing.T) {
	bak, acctH, owner, _, mine, ownerID := seedBackupAccounts(t)
	_, _ = bak.DB.Exec(`DELETE FROM devices WHERE id = ?`, mine)
	okReq := httptest.NewRequest(http.MethodPost, "/backups/download", strings.NewReader(`{"device_id":"`+mine+`","path":"Photos/a.jpg"}`))
	okReq.AddCookie(owner)
	okRec := withAccount(acctH, bak.Download, okReq)
	if okRec.Code != 200 || !strings.Contains(okRec.Body.String(), "owner-bytes") {
		t.Fatalf("download after delete %d %s", okRec.Code, okRec.Body.String())
	}
	_ = ownerID
}

func TestShouldSendWarningSchedule(t *testing.T) {
	if !shouldSendWarning(0, -1) || !shouldSendWarning(3, 0) || shouldSendWarning(4, 3) || shouldSendWarning(3, 3) {
		t.Fatal("schedule")
	}
}

func TestTransferTokenRateLimit(t *testing.T) {
	onb, acct, _ := testOnboarding(t)
	cookie := registerAccount(t, acct, "rl@b.co")
	tok := mintOfficial(t, onb)
	if rec := pairOfficial(t, onb, acct, cookie, tok, "rate", "203.0.113.90:1"); rec.Code != 201 {
		t.Fatalf("name %d %s", rec.Code, rec.Body.String())
	}
	for i := 0; i < 3; i++ {
		// Re-insert a device after each transfer so the next mint is allowed by the live-device check.
		if i > 0 {
			var id string
			_ = acct.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'rl@b.co'`).Scan(&id)
			_, _ = acct.DB.Exec(`INSERT INTO devices (id, account_id, token_hash, name, subdomain, tunnel_id, local_port, created_at)
VALUES (?, ?, ?, 'Luna', ?, '', 8090, ?)`, security.NewID("dev"), id, security.HashToken(security.NewID("tok")), "rate"+string(rune('a'+i)), time.Now().Unix())
		}
		req := httptest.NewRequest(http.MethodPost, "/account/transfer-token", nil)
		req.AddCookie(cookie)
		rec := withAccount(acct, acct.TransferToken, req)
		if rec.Code != 201 {
			t.Fatalf("mint %d: %d %s", i, rec.Code, rec.Body.String())
		}
	}
	var id string
	_ = acct.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'rl@b.co'`).Scan(&id)
	_, _ = acct.DB.Exec(`INSERT INTO devices (id, account_id, token_hash, name, subdomain, local_port, created_at)
VALUES (?, ?, ?, 'Luna', 'ratez', 8090, ?)`, security.NewID("dev"), id, security.HashToken("rl-last"), time.Now().Unix())
	req := httptest.NewRequest(http.MethodPost, "/account/transfer-token", nil)
	req.AddCookie(cookie)
	rec := withAccount(acct, acct.TransferToken, req)
	if rec.Code != http.StatusTooManyRequests {
		t.Fatalf("4th mint %d %s", rec.Code, rec.Body.String())
	}
}
