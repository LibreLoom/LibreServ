package billing

import (
	"database/sql"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

func billingDevice(t *testing.T, db *sql.DB, plan string) string {
	t.Helper()
	accountID := security.GenerateID("acct")
	deviceID := security.GenerateID("dev")
	if _, err := db.Exec(
		`INSERT INTO customer_accounts (id, email, password_hash, plan_id) VALUES ($1, $2, 'hash', $3)`,
		accountID, accountID+"@example.com", plan); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(
		`INSERT INTO devices (id, account_id, plan_id) VALUES ($1, $2, $3)`,
		deviceID, accountID, plan); err != nil {
		t.Fatal(err)
	}
	return deviceID
}

func TestCreditAndUsageLifecycle(t *testing.T) {
	db := database.OpenTestDB(t)
	deviceID := billingDevice(t, db, "lite")
	svc := NewService(db)
	if svc.DB() != db {
		t.Fatal("DB returned a different connection")
	}
	if err := svc.EnsureAccountCredits(deviceID); err != nil {
		t.Fatalf("EnsureAccountCredits: %v", err)
	}
	if _, err := db.Exec(`UPDATE account_credits SET balance_cents = 1000 WHERE device_id = $1`, deviceID); err != nil {
		t.Fatal(err)
	}
	if got, err := svc.GetBalance(deviceID); err != nil || got != 1000 {
		t.Fatalf("GetBalance = %d, %v", got, err)
	}
	if err := svc.DeductCredit(deviceID, 250, "usage", "event-1"); err != nil {
		t.Fatalf("DeductCredit: %v", err)
	}
	if got, err := svc.GetBalance(deviceID); err != nil || got != 750 {
		t.Fatalf("balance after deduct = %d, %v", got, err)
	}
	if err := svc.DeductCredit(deviceID, 1000, "too much", "event-2"); err == nil || !strings.Contains(err.Error(), "insufficient") {
		t.Fatalf("insufficient deduction error = %v", err)
	}

	if err := svc.RecordUsage(deviceID, "lite", "smtp", "emails", 10, 0.5, 0.2); err != nil {
		t.Fatal(err)
	}
	if err := svc.RecordUsage(deviceID, "lite", "ai", "messages", 3, 0.75, 0.3); err != nil {
		t.Fatal(err)
	}
	summary, err := svc.GetUsageSummary(deviceID)
	if err != nil || summary.TotalCostUSD != 1.25 || len(summary.ByService) != 2 {
		t.Fatalf("GetUsageSummary = %#v, %v", summary, err)
	}
	adminSummary, err := svc.GetDeviceUsageForAdmin(deviceID)
	if err != nil || adminSummary.DeviceID != deviceID {
		t.Fatalf("GetDeviceUsageForAdmin = %#v, %v", adminSummary, err)
	}
	aggregated, err := svc.GetAggregatedUsage()
	if err != nil || aggregated["total_cost"] != 1.25 || aggregated["smtp_provider_cost"] != 0.2 {
		t.Fatalf("GetAggregatedUsage = %#v, %v", aggregated, err)
	}
}

func TestQuotaBranches(t *testing.T) {
	db := database.OpenTestDB(t)
	freeDevice := billingDevice(t, db, "free")
	paidDevice := billingDevice(t, db, "one")
	svc := NewService(db)

	if remaining, allowed, err := svc.CheckQuota(freeDevice, "smtp", 1); err != nil || !allowed || remaining != 30 {
		t.Fatalf("free SMTP quota = %v, %v, %v", remaining, allowed, err)
	}
	if err := svc.RecordUsage(freeDevice, "free", "smtp", "emails", 30, 0, 0); err != nil {
		t.Fatal(err)
	}
	if remaining, allowed, err := svc.CheckQuota(freeDevice, "smtp", 1); err != nil || allowed || remaining != 0 {
		t.Fatalf("exhausted SMTP quota = %v, %v, %v", remaining, allowed, err)
	}
	if _, allowed, err := svc.CheckQuota(freeDevice, "backup", 1); err != nil || allowed {
		t.Fatalf("free backup quota = %v, %v", allowed, err)
	}
	if remaining, allowed, err := svc.CheckQuota(freeDevice, "ai", 1); err != nil || !allowed || remaining != 50 {
		t.Fatalf("free AI quota = %v, %v, %v", remaining, allowed, err)
	}
	if _, allowed, err := svc.CheckQuota(paidDevice, "ai", 1000); err != nil || !allowed {
		t.Fatalf("paid AI quota = %v, %v", allowed, err)
	}
	if _, allowed, err := svc.CheckQuota(paidDevice, "tunnel", 1000); err != nil || !allowed {
		t.Fatalf("tunnel quota = %v, %v", allowed, err)
	}
	if _, allowed, err := svc.CheckQuota(paidDevice, "unknown", 1000); err != nil || !allowed {
		t.Fatalf("unknown quota = %v, %v", allowed, err)
	}
	if _, _, err := svc.CheckQuota("missing", "smtp", 1); err == nil {
		t.Fatal("missing device quota did not fail")
	}

	unknown := billingDevice(t, db, "free")
	if _, err := db.Exec(`UPDATE devices SET plan_id = 'unknown' WHERE id = $1`, unknown); err != nil {
		t.Fatal(err)
	}
	if _, _, err := svc.CheckQuota(unknown, "smtp", 1); err == nil {
		t.Fatal("unknown plan quota did not fail")
	}
}
