package handlers

import (
	"database/sql"
	"log/slog"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/mail"
)

const backupRetentionDays = 30

var purgeWarningDays = []int{0, 3, 7, 14, 21, 27}

func scheduleBackupPurge(db *sql.DB, accountID string) int64 {
	if db == nil || accountID == "" {
		return 0
	}
	var existing sql.NullInt64
	_ = db.QueryRow(`SELECT backup_purge_after FROM accounts WHERE id = ?`, accountID).Scan(&existing)
	if existing.Valid && existing.Int64 > 0 {
		return existing.Int64
	}
	deadline := time.Now().Unix() + int64(backupRetentionDays)*86400
	if _, err := db.Exec(`UPDATE accounts SET backup_purge_after = ?, purge_mail_day = -1 WHERE id = ?`, deadline, accountID); err != nil {
		slog.Error("schedule backup purge", "err", err)
	}
	return deadline
}

func purgeMail(day int) (subject, text string) {
	if day >= backupRetentionDays {
		return "Your cloud copies were deleted",
			"The 30 days are up. The cloud copies for this account are gone."
	}
	left := backupRetentionDays - day
	if left < 1 {
		left = 1
	}
	days := "30 days"
	if left == 1 {
		days = "1 day"
	} else if day > 0 {
		days = itoa(left) + " days"
	}
	return "Make sure you have your files",
		"Payment for cloud backup is off. We still have your copies for " + days + ". Sign in at connect.luna.libreloom.org and download anything you need before we delete them."
}

func sendPurgeWarning(sender mail.Sender, email string, day int, deadline int64) {
	email = strings.TrimSpace(email)
	subject, text := purgeMail(day)
	if sender == nil || email == "" {
		if email != "" {
			slog.Info("purge warning (no mailer)", "day", day, "deadline", deadline, "subject", subject)
		}
		return
	}
	if err := sender.Send(email, subject, text); err != nil {
		slog.Warn("purge warning mail failed", "err", err)
	}
}

func markAndSendPurgeWarning(deps Deps, accountID, email string, day int, deadline int64) {
	if accountID == "" {
		return
	}
	var last sql.NullInt64
	_ = deps.DB.QueryRow(`SELECT purge_mail_day FROM accounts WHERE id = ?`, accountID).Scan(&last)
	if last.Valid && int(last.Int64) >= day {
		return
	}
	sendPurgeWarning(deps.Mail, email, day, deadline)
	_, _ = deps.DB.Exec(`UPDATE accounts SET purge_mail_day = ? WHERE id = ?`, day, accountID)
}

func beginBackupPurgeForAccount(deps Deps, accountID, email string) int64 {
	deadline := scheduleBackupPurge(deps.DB, accountID)
	markAndSendPurgeWarning(deps, accountID, email, 0, deadline)
	return deadline
}

func beginBackupPurgeForSubscription(deps Deps, subID string) {
	if subID == "" || deps.DB == nil {
		return
	}
	var accountID, email string
	if err := deps.DB.QueryRow(`SELECT id, email FROM accounts WHERE stripe_subscription_id = ?`, subID).Scan(&accountID, &email); err != nil || accountID == "" {
		return
	}
	beginBackupPurgeForAccount(deps, accountID, email)
}

func daysSincePurgeStart(purgeAfter, now int64) int {
	start := purgeAfter - int64(backupRetentionDays)*86400
	if now < start {
		return 0
	}
	return int((now - start) / 86400)
}

func shouldSendWarning(day, lastSent int) bool {
	if day < 0 || lastSent >= day {
		return false
	}
	for _, d := range purgeWarningDays {
		if d == day {
			return true
		}
	}
	return false
}

// ProcessRetention sends backup-delete warnings and deletes copies after 30 days.
func ProcessRetention(deps Deps, now int64) {
	if deps.DB == nil {
		return
	}
	if now <= 0 {
		now = time.Now().Unix()
	}
	rows, err := deps.DB.Query(`
		SELECT id, email, backup_purge_after, COALESCE(purge_mail_day, -1)
		FROM accounts
		WHERE backup_purge_after IS NOT NULL AND backup_purge_after > 0
	`)
	if err != nil {
		slog.Error("retention query", "err", err)
		return
	}
	defer rows.Close()

	type row struct {
		id, email string
		after     int64
		last      int64
	}
	var list []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.email, &r.after, &r.last); err != nil {
			continue
		}
		list = append(list, r)
	}
	for _, r := range list {
		if now >= r.after {
			purgeAccountBackups(deps, r.id, r.email)
			continue
		}
		day := daysSincePurgeStart(r.after, now)
		if shouldSendWarning(day, int(r.last)) {
			markAndSendPurgeWarning(deps, r.id, r.email, day, r.after)
		}
	}
}

func purgeAccountBackups(deps Deps, accountID, email string) {
	_, _ = deps.DB.Exec(`DELETE FROM backup_objects WHERE account_id = ?`, accountID)
	if deps.Store != nil {
		if err := deps.Store.DeleteAccount(accountID); err != nil {
			slog.Error("purge store", "account", accountID, "err", err)
		}
	}
	markAndSendPurgeWarning(deps, accountID, email, backupRetentionDays, 0)
	_, _ = deps.DB.Exec(`UPDATE accounts SET backup_purge_after = NULL, purge_mail_day = ? WHERE id = ?`, backupRetentionDays, accountID)
}
