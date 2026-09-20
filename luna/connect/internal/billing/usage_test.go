package billing

import (
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
)

func TestAverageStoredBytes(t *testing.T) {
	if got := AverageStoredBytes(0, 0); got != 0 {
		t.Fatalf("empty=%d", got)
	}
	// 27 TB for 29 days + 0 for 1 day (daily samples) → ~26.1 TB
	const tb = int64(BytesPerTB)
	sum := 27*tb*29 + 0
	avg := AverageStoredBytes(sum, 30)
	want := (27 * tb * 29) / 30
	if avg != want {
		t.Fatalf("avg=%d want %d", avg, want)
	}
	// Must not be near zero — emptying one day must not wipe the month.
	if avg < 26*tb {
		t.Fatalf("avg too low for anti-game: %d", avg)
	}
}

func TestEgressOverageGB(t *testing.T) {
	avg := int64(27 * BytesPerTB) // 27 TB average
	// One full dump = 27 TB egress; free = 3×27 = 81 TB → overage 0
	if got := EgressOverageGB(avg, 27*BytesPerTB); got != 0 {
		t.Fatalf("one dump overage=%d want 0", got)
	}
	// Two full dumps = 54 TB; still under 81 → 0
	if got := EgressOverageGB(avg, 54*BytesPerTB); got != 0 {
		t.Fatalf("two dumps overage=%d want 0", got)
	}
	// Four full dumps = 108 TB; overage = 108−81 = 27 TB = 27000 GB
	if got := EgressOverageGB(avg, 108*BytesPerTB); got != 27_000 {
		t.Fatalf("four dumps overage=%d want 27000", got)
	}
	// Exact boundary: egress == 3×avg → 0
	if got := EgressOverageGB(avg, 3*avg); got != 0 {
		t.Fatalf("exact 3x=%d", got)
	}
	// 1 byte over → floor to 0 GB (under 1 GB free)
	if got := EgressOverageGB(avg, 3*avg+1); got != 0 {
		t.Fatalf("1 byte over=%d", got)
	}
	// Exactly 1 GB over
	if got := EgressOverageGB(avg, 3*avg+BytesPerGB); got != 1 {
		t.Fatalf("1 GB over=%d", got)
	}
	if got := EgressOverageGB(0, BytesPerGB); got != 1 {
		t.Fatalf("zero storage egress=%d", got)
	}
	if got := EgressOverageGB(avg, 0); got != 0 {
		t.Fatalf("no egress=%d", got)
	}
}

func TestEstimateMonthUSDIncludesEgress(t *testing.T) {
	avg := int64(BytesPerTB) // 1 TB → $8 storage
	// 4 TB egress with 1 TB avg → free 3 TB, overage 1 TB = 1000 GB × $0.01 = $10
	got := EstimateMonthUSD(avg, 4*BytesPerTB)
	want := 8.0 + 10.0
	if got != want {
		t.Fatalf("estimate=%v want %v", got, want)
	}
}

func TestSampleAndRecordEgress(t *testing.T) {
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := database.Migrate(db); err != nil {
		t.Fatal(err)
	}
	_, _ = db.Exec(`INSERT INTO accounts (id, email, password_hash, has_card, billing_status, stripe_customer_id, stripe_subscription_id, created_at)
VALUES ('acct_1', 'a@b.co', 'x', 1, 'active', 'cus_test', 'sub_test', 1)`)
	_, _ = db.Exec(`INSERT INTO backup_objects (id, account_id, device_id, relative_path, size, updated_at)
VALUES ('o1', 'acct_1', 'dev_1', 'a.bin', ?, 1)`, 10*BytesPerGB)

	SampleStorage(db)
	avg, egress := AccountPeriodUsage(db, "acct_1")
	if avg != 10*BytesPerGB {
		t.Fatalf("avg after sample=%d", avg)
	}
	if egress != 0 {
		t.Fatalf("egress=%d", egress)
	}

	RecordEgress(db, "acct_1", 5*BytesPerGB)
	RecordEgress(db, "acct_1", 2*BytesPerGB)
	_, egress = AccountPeriodUsage(db, "acct_1")
	if egress != 7*BytesPerGB {
		t.Fatalf("egress sum=%d", egress)
	}

	// Second sample same hour is upsert; add a distinct hour sample with lower size.
	period := PeriodKeyUTC(time.Now())
	earlier := time.Now().UTC().Unix() - 7200
	earlier -= earlier % 3600
	_, _ = db.Exec(`INSERT INTO billing_storage_samples (account_id, period_ym, sampled_at, stored_bytes)
VALUES ('acct_1', ?, ?, ?)`, period, earlier, 0)
	avg, _ = AccountPeriodUsage(db, "acct_1")
	// mean of 10GB and 0 = 5GB
	if avg != 5*BytesPerGB {
		t.Fatalf("two-sample avg=%d want %d", avg, 5*BytesPerGB)
	}

	usages, err := LoadPeriodUsage(db, period)
	if err != nil || len(usages) != 1 {
		t.Fatalf("load: %v n=%d", err, len(usages))
	}
	if usages[0].AvgStorageBytes != 5*BytesPerGB || usages[0].EgressBytes != 7*BytesPerGB {
		t.Fatalf("%+v", usages[0])
	}
	if EgressOverageGB(usages[0].AvgStorageBytes, usages[0].EgressBytes) != 0 {
		t.Fatal("7 GB egress with 5 GB avg still under 3× free")
	}
}
