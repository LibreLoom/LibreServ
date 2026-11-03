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
	avg := int64(BytesPerTB) // 1 TB → $8 storage, already above the minimum
	// 4 TB egress with 1 TB avg → free 3 TB, overage 1 TB = 1000 GB × $0.01 = $10
	got := EstimateMonthUSD(avg, 4*BytesPerTB)
	want := 8.0 + 10.0
	if got != want {
		t.Fatalf("estimate=%v want %v", got, want)
	}
}

// The minimum is on the month's whole bill: max($3, storage + egress). Egress
// counts toward it rather than sitting on top.
func TestMinimumAppliesToStorageAndEgressTogether(t *testing.T) {
	GB := int64(BytesPerGB)
	cases := []struct {
		name   string
		avg    int64
		egress int64
		want   float64
	}{
		{"nothing stored, no egress", 0, 0, 0},
		{"nothing stored, egress only", 0, 10 * int64(BytesPerTB), 0},
		{"3 GB stored", 3 * GB, 0, MinimumMonthlyUSD},
		{"3 GB stored, egress under free allowance", 3 * GB, 5 * GB, MinimumMonthlyUSD},
		{"250 GB stored", 250 * GB, 0, MinimumMonthlyUSD},
		{"exactly at the floor", MinBillableGB * GB, 0, MinimumMonthlyUSD},
		{"above the floor", (MinBillableGB + 1) * GB, 0, 3.008},
		{"1 TB", int64(BytesPerTB), 0, 8.0},
	}
	for _, tc := range cases {
		if got := EstimateMonthUSD(tc.avg, tc.egress); got != tc.want {
			t.Errorf("%s: estimate=%v want %v", tc.name, got, tc.want)
		}
	}
}

// The two reported quantities must always bill at least the minimum once
// anything is stored.
func TestMeteredQuantitiesReachMinimum(t *testing.T) {
	GB := int64(BytesPerGB)
	for _, avg := range []int64{1, GB, 3 * GB, 100 * GB, 250 * GB, MinBillableGB * GB} {
		for _, egress := range []int64{0, 5 * GB, 100 * GB, 400 * GB} {
			storageGB, overGB := MeteredQuantities(avg, egress)
			mills := storageGB*MillsPerGBStorage + overGB*MillsPerGBEgress
			if mills < MinimumMonthlyMills {
				t.Errorf("avg=%d egress=%d bills %d mills, below the %d mill minimum", avg, egress, mills, MinimumMonthlyMills)
			}
		}
	}
	// Nothing stored reports nothing on either meter.
	if s, o := MeteredQuantities(0, 10*int64(BytesPerTB)); s != 0 || o != 0 {
		t.Errorf("empty account reported storage=%d egress=%d, want 0/0", s, o)
	}
}

// Egress overage beyond the minimum must not also be covered by a storage
// top-up: the account pays its real (small) storage plus its real egress, which
// is the "at least the minimum, otherwise what you used" rule. It must never
// bill the minimum twice.
func TestEgressBeyondTheMinimumIsNotToppedUp(t *testing.T) {
	GB := int64(BytesPerGB)
	avg := 3 * GB
	egress := int64(400 * GB) // 391 GB overage × $0.01 = $3.91, above the minimum
	storageGB, overGB := MeteredQuantities(avg, egress)

	// Storage bills at its real size, not a top-up.
	if storageGB != 3 {
		t.Errorf("storage quantity=%d, want the real 3 GB", storageGB)
	}
	// And the total is exactly storage + egress, with no hidden minimum added.
	total := float64(storageGB*MillsPerGBStorage+overGB*MillsPerGBEgress) / float64(MillsPerDollar)
	want := 0.024 + 3.91
	if diff := total - want; diff > 1e-9 || diff < -1e-9 {
		t.Errorf("total=%v want %v", total, want)
	}
	if total < MinimumMonthlyUSD {
		t.Errorf("total=%v, want at least %v", total, MinimumMonthlyUSD)
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
	_, _ = db.Exec(`INSERT INTO storage_packs (account_id, luna_id, id, scope, size, created_at, storage_backend)
VALUES ('acct_1', 'luna-t', 'p1', '', ?, 1, 'local')`, 10*BytesPerGB)

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
