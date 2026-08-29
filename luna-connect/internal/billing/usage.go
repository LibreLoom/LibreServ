package billing

import (
	"database/sql"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/stripe/stripe-go/v76"
	"github.com/stripe/stripe-go/v76/billing/meterevent"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
)

// Billing model (Backblaze B2–style, LibreLoom retail rates):
//
//   Storage charge = average GB stored over the UTC calendar month × $0.008/GB.
//   We sample stored bytes hourly into billing_storage_samples, compute the
//   arithmetic mean ourselves, and report that average to Stripe with meter
//   aggregation "last" (gauge: "average GB so far this period"). Emptying for
//   one day before invoice does not zero the month — 27 TB × 29 days + 0 × 1
//   day ≈ 26.1 TB average.
//
//   Egress: downloads are free up to 3× average monthly storage (byte-for-byte).
//   Overage GB = floor(max(0, egress_bytes − 3×avg_storage_bytes) / 1e9),
//   billed at $0.01/GB via a second meter (also aggregation "last").
//
// Period key is UTC YYYY-MM (calendar month). Stripe subscription anchors may
// differ slightly; we still use calendar months to match B2’s model.

const (
	EgressFreeMultiplier = 3
	DollarsPerEgressGB   = 0.01
)

// PeriodKeyUTC returns the UTC calendar-month key (YYYY-MM) for t.
func PeriodKeyUTC(t time.Time) string {
	return t.UTC().Format("2006-01")
}

// AverageStoredBytes is the arithmetic mean of samples (B2-style monthly average).
func AverageStoredBytes(sampleSum, sampleCount int64) int64 {
	if sampleCount <= 0 {
		return 0
	}
	return sampleSum / sampleCount
}

// EgressOverageGB is download GB billed after the free 3× average-storage allowance.
// free_bytes = 3 × avg_storage_bytes; overage_gb = floor(max(0, egress − free) / 1e9).
func EgressOverageGB(avgStorageBytes, egressBytes int64) int64 {
	if egressBytes <= 0 {
		return 0
	}
	free := EgressFreeMultiplier * avgStorageBytes
	if free < 0 {
		free = 0
	}
	over := egressBytes - free
	if over <= 0 {
		return 0
	}
	return over / BytesPerGB
}

// EstimateMonthUSD estimates storage + egress overage for UI (average so far).
func EstimateMonthUSD(avgStorageBytes, egressBytes int64) float64 {
	storage := EstimateUSD(avgStorageBytes)
	overGB := EgressOverageGB(avgStorageBytes, egressBytes)
	return storage + float64(overGB)*DollarsPerEgressGB
}

// SampleStorage records current SUM(backup_objects.size) for every account that
// has ever stored data or has an active subscription. Call at least hourly.
func SampleStorage(db *sql.DB) {
	if db == nil {
		return
	}
	now := time.Now().UTC()
	period := PeriodKeyUTC(now)
	ts := now.Unix()
	// One sample per account per hour (idempotent on conflict).
	hourBucket := ts - (ts % 3600)

	rows, err := db.Query(`
SELECT a.id, COALESCE(SUM(b.size), 0)
FROM accounts a
LEFT JOIN backup_objects b ON b.account_id = a.id
WHERE (a.stripe_subscription_id IS NOT NULL AND a.stripe_subscription_id != '')
   OR EXISTS (SELECT 1 FROM backup_objects bo WHERE bo.account_id = a.id)
GROUP BY a.id`)
	if err != nil {
		slog.Warn("storage sample query failed", "error", err)
		return
	}
	defer rows.Close()
	for rows.Next() {
		var accountID string
		var bytes int64
		if err := rows.Scan(&accountID, &bytes); err != nil {
			continue
		}
		_, err := db.Exec(`
INSERT INTO billing_storage_samples (account_id, period_ym, sampled_at, stored_bytes)
VALUES (?, ?, ?, ?)
ON CONFLICT(account_id, sampled_at) DO UPDATE SET stored_bytes = excluded.stored_bytes, period_ym = excluded.period_ym`,
			accountID, period, hourBucket, bytes)
		if err != nil {
			slog.Warn("storage sample insert failed", "account", accountID, "error", err)
		}
		_, _ = db.Exec(`
INSERT INTO billing_period_egress (account_id, period_ym, egress_bytes)
VALUES (?, ?, 0)
ON CONFLICT(account_id, period_ym) DO NOTHING`, accountID, period)
	}
	// Drop samples older than two months (keep current + previous for audit).
	cutoff := now.AddDate(0, -2, 0).Format("2006-01")
	_, _ = db.Exec(`DELETE FROM billing_storage_samples WHERE period_ym < ?`, cutoff)
	_, _ = db.Exec(`DELETE FROM billing_period_egress WHERE period_ym < ?`, cutoff)
}

// RecordEgress adds successful download bytes to the account’s current UTC month.
func RecordEgress(db *sql.DB, accountID string, bytes int64) {
	if db == nil || accountID == "" || bytes <= 0 {
		return
	}
	period := PeriodKeyUTC(time.Now())
	_, err := db.Exec(`
INSERT INTO billing_period_egress (account_id, period_ym, egress_bytes)
VALUES (?, ?, ?)
ON CONFLICT(account_id, period_ym) DO UPDATE SET egress_bytes = egress_bytes + excluded.egress_bytes`,
		accountID, period, bytes)
	if err != nil {
		slog.Warn("egress record failed", "account", accountID, "error", err)
	}
}

// PeriodUsage holds average storage and egress for one account in a period.
type PeriodUsage struct {
	AccountID       string
	CustomerID      string
	AvgStorageBytes int64
	EgressBytes     int64
	SampleCount     int64
}

// LoadPeriodUsage returns month-to-date average storage + egress for billed accounts.
func LoadPeriodUsage(db *sql.DB, period string) ([]PeriodUsage, error) {
	if db == nil {
		return nil, nil
	}
	if period == "" {
		period = PeriodKeyUTC(time.Now())
	}
	rows, err := db.Query(`
SELECT a.id, a.stripe_customer_id,
       COALESCE(s.sample_sum, 0), COALESCE(s.sample_count, 0),
       COALESCE(e.egress_bytes, 0),
       COALESCE((SELECT SUM(size) FROM backup_objects WHERE account_id = a.id), 0)
FROM accounts a
LEFT JOIN (
  SELECT account_id, SUM(stored_bytes) AS sample_sum, COUNT(*) AS sample_count
  FROM billing_storage_samples WHERE period_ym = ?
  GROUP BY account_id
) s ON s.account_id = a.id
LEFT JOIN billing_period_egress e ON e.account_id = a.id AND e.period_ym = ?
WHERE a.stripe_customer_id IS NOT NULL AND a.stripe_customer_id != ''
  AND a.stripe_subscription_id IS NOT NULL AND a.stripe_subscription_id != ''
  AND a.has_card = 1`, period, period)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []PeriodUsage
	for rows.Next() {
		var u PeriodUsage
		var sum, count, currentBytes int64
		if err := rows.Scan(&u.AccountID, &u.CustomerID, &sum, &count, &u.EgressBytes, &currentBytes); err != nil {
			continue
		}
		u.SampleCount = count
		if count > 0 {
			u.AvgStorageBytes = AverageStoredBytes(sum, count)
		} else {
			// No samples yet this period — use live size so first report is sane.
			u.AvgStorageBytes = currentBytes
		}
		out = append(out, u)
	}
	return out, nil
}

// AccountPeriodUsage returns average storage + egress for one account (UI).
func AccountPeriodUsage(db *sql.DB, accountID string) (avgBytes, egressBytes int64) {
	if db == nil || accountID == "" {
		return 0, 0
	}
	period := PeriodKeyUTC(time.Now())
	var sum, count sql.NullInt64
	_ = db.QueryRow(`
SELECT SUM(stored_bytes), COUNT(*) FROM billing_storage_samples
WHERE account_id = ? AND period_ym = ?`, accountID, period).Scan(&sum, &count)
	if count.Valid && count.Int64 > 0 && sum.Valid {
		avgBytes = AverageStoredBytes(sum.Int64, count.Int64)
	} else {
		_ = db.QueryRow(`SELECT COALESCE(SUM(size),0) FROM backup_objects WHERE account_id = ?`, accountID).Scan(&avgBytes)
	}
	_ = db.QueryRow(`
SELECT COALESCE(egress_bytes,0) FROM billing_period_egress
WHERE account_id = ? AND period_ym = ?`, accountID, period).Scan(&egressBytes)
	return avgBytes, egressBytes
}

// ReportUsage samples once, then reports period-average storage GB and egress
// overage GB to Stripe Billing Meters (aggregation must be Last on both).
func ReportUsage(db *sql.DB) {
	providers.RefreshStripe()
	if db == nil || !config.C.Stripe.Ready() {
		return
	}
	storageMeter := strings.TrimSpace(config.C.Stripe.MeterEventName)
	if storageMeter == "" {
		slog.Warn("stripe meter events skipped: meter_event_name not set")
		return
	}
	SampleStorage(db)

	period := PeriodKeyUTC(time.Now())
	usages, err := LoadPeriodUsage(db, period)
	if err != nil {
		slog.Warn("usage query failed", "error", err)
		return
	}
	stripe.Key = config.C.Stripe.SecretKey
	egressMeter := strings.TrimSpace(config.C.Stripe.EgressMeterEventName)
	now := time.Now().Unix()
	for _, u := range usages {
		if !strings.HasPrefix(u.CustomerID, "cus_") {
			slog.Warn("skip meter event: not a stripe customer id")
			continue
		}
		storageGB := UsageQuantityGB(u.AvgStorageBytes)
		ident := fmt.Sprintf("%s-storage-%s-%d", u.CustomerID, period, now)
		_, err := meterevent.New(&stripe.BillingMeterEventParams{
			EventName:  stripe.String(storageMeter),
			Identifier: stripe.String(ident),
			Timestamp:  stripe.Int64(now),
			Payload: map[string]string{
				"stripe_customer_id": u.CustomerID,
				"value":              strconv.FormatInt(storageGB, 10),
			},
		})
		if err != nil {
			slog.Warn("stripe storage meter event failed", "customer", u.CustomerID, "error", err)
		}

		if egressMeter == "" {
			continue
		}
		overGB := EgressOverageGB(u.AvgStorageBytes, u.EgressBytes)
		eident := fmt.Sprintf("%s-egress-%s-%d", u.CustomerID, period, now)
		_, err = meterevent.New(&stripe.BillingMeterEventParams{
			EventName:  stripe.String(egressMeter),
			Identifier: stripe.String(eident),
			Timestamp:  stripe.Int64(now),
			Payload: map[string]string{
				"stripe_customer_id": u.CustomerID,
				"value":              strconv.FormatInt(overGB, 10),
			},
		})
		if err != nil {
			slog.Warn("stripe egress meter event failed", "customer", u.CustomerID, "error", err)
		}
	}
}
