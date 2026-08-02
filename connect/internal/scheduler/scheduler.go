package scheduler

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"strconv"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/services"
)

// Scheduler periodically syncs custom domain state with Cloudflare Registrar.
// It corrects estimated expiry dates, refreshes renewal costs, revokes expired
// grace domains, deducts credit on CF auto-renewal, retries payment-failed
// domains, and detects orphaned domains.
type Scheduler struct {
	db        *sql.DB
	registrar *providers.RegistrarClient
	billing   *billing.Service
	interval  time.Duration
	done      chan struct{}
}

// New creates a domain sync scheduler.
func New(db *sql.DB, registrar *providers.RegistrarClient, billingSvc *billing.Service, interval time.Duration) *Scheduler {
	return &Scheduler{
		db:        db,
		registrar: registrar,
		billing:   billingSvc,
		interval:  interval,
		done:      make(chan struct{}),
	}
}

// Start launches the scheduler in a background goroutine.
func (s *Scheduler) Start() {
	go s.run()
	slog.Info("domain sync scheduler started", "interval", s.interval)
}

// Stop signals the scheduler to stop and blocks until it exits.
func (s *Scheduler) Stop() {
	close(s.done)
}

func (s *Scheduler) run() {
	ticker := time.NewTicker(s.interval)
	defer ticker.Stop()

	for {
		select {
		case <-s.done:
			return
		case <-ticker.C:
			if err := s.syncDomains(); err != nil {
				slog.Error("domain sync failed", "error", err)
			}
		}
	}
}

// SyncDomains is the exported entry point for testing — it runs one sync cycle.
func (s *Scheduler) SyncDomains() error {
	return s.syncDomains()
}

// domainRow holds the fields the scheduler needs for each custom domain.
type domainRow struct {
	ID               string
	DeviceID         sql.NullString
	Domain           string
	Status           string
	ExpiresAt        sql.NullTime
	AutoRenew        bool
	RenewalCostCents sql.NullInt64
}

func (s *Scheduler) syncDomains() error {
	ctx := context.Background()

	// Look up Cloudflare credentials once per sync cycle.
	apiToken, cfAccountID, err := s.lookUpTunnelCredentials(ctx)
	if err != nil {
		return nil // no tunnel provider configured — nothing to sync
	}

	rows, err := s.db.QueryContext(ctx,
		`SELECT id, device_id, account_id, domain, status, expires_at, auto_renew, renewal_cost_cents
		 FROM custom_domains WHERE status IN ('active', 'grace', 'payment_failed')`)
	if err != nil {
		return err
	}
	defer rows.Close()

	var domains []domainRow
	for rows.Next() {
		var dr domainRow
		var accountID sql.NullString
		if err := rows.Scan(&dr.ID, &dr.DeviceID, &accountID, &dr.Domain, &dr.Status, &dr.ExpiresAt, &dr.AutoRenew, &dr.RenewalCostCents); err != nil {
			slog.Warn("failed to scan domain row", "error", err)
			continue
		}
		domains = append(domains, dr)
	}

	now := time.Now()

	for _, d := range domains {
		s.syncSingleDomain(ctx, d, apiToken, cfAccountID, now)
	}

	// Orphan detection: compare CF domains against our DB.
	s.detectOrphans(ctx, apiToken, cfAccountID)

	return nil
}

func (s *Scheduler) syncSingleDomain(ctx context.Context, d domainRow, apiToken, cfAccountID string, now time.Time) {
	// Fetch live data from Cloudflare.
	info, err := s.registrar.GetDomain(cfAccountID, apiToken, d.Domain)
	if err != nil {
		slog.Warn("scheduler: failed to get domain from CF", "error", err, "domain", d.Domain)
		return
	}

	// Update expires_at with the CF-reported value.
	if !info.ExpiresAt.IsZero() {
		_, _ = s.db.ExecContext(ctx,
			`UPDATE custom_domains SET expires_at = $1 WHERE id = $2`,
			info.ExpiresAt, d.ID)
		d.ExpiresAt = sql.NullTime{Time: info.ExpiresAt, Valid: true}
	}

	// Refresh renewal cost via CheckDomain.
	if renewalCents, ok := s.refreshRenewalCost(ctx, d.Domain, apiToken, cfAccountID, d.ID); ok {
		d.RenewalCostCents = sql.NullInt64{Int64: renewalCents, Valid: true}
	}

	switch d.Status {
	case "grace":
		// If grace domain has expired, revoke it.
		if d.ExpiresAt.Valid && !d.ExpiresAt.Time.After(now) {
			s.revokeExpiredDomain(ctx, d)
		}

	case "active":
		// If auto_renew is true on CF and expiry moved to the future, CF renewed it.
		if info.AutoRenew && d.ExpiresAt.Valid && d.ExpiresAt.Time.After(now) {
			s.handleAutoRenewal(ctx, d, apiToken, cfAccountID)
		}

	case "payment_failed":
		// Retry: try to deduct credit again.
		s.retryPaymentFailed(ctx, d, apiToken, cfAccountID)
	}
}

// refreshRenewalCost calls CheckDomain to get the current renewal price and
// updates the DB. Returns the cents and true on success.
func (s *Scheduler) refreshRenewalCost(ctx context.Context, domain, apiToken, cfAccountID, domainID string) (int64, bool) {
	di, err := s.registrar.CheckDomain(cfAccountID, apiToken, domain)
	if err != nil || di == nil {
		return 0, false
	}
	cents, err := parseDomainCostToCents(di.RenewalCost)
	if err != nil || cents <= 0 {
		return 0, false
	}
	_, _ = s.db.ExecContext(ctx,
		`UPDATE custom_domains SET renewal_cost_cents = $1 WHERE id = $2`,
		cents, domainID)
	return cents, true
}

// handleAutoRenewal deducts the renewal cost from the device's account credit
// when Cloudflare has auto-renewed the domain. CF charges its own payment method;
// LibreServ recovers the cost by charging the user's credit at the exact at-cost price.
// If no device is linked, the domain is skipped (no credit to deduct from).
func (s *Scheduler) handleAutoRenewal(ctx context.Context, d domainRow, apiToken, cfAccountID string) {
	if !d.DeviceID.Valid {
		slog.Warn("scheduler: domain has no device linked, cannot auto-renewal", "domain", d.Domain)
		return
	}
	renewalCost := int64(0)
	if d.RenewalCostCents.Valid {
		renewalCost = d.RenewalCostCents.Int64
	}
	if renewalCost <= 0 {
		slog.Warn("scheduler: cannot deduct renewal — no renewal cost recorded", "domain", d.Domain)
		return
	}

	if err := s.billing.DeductCredit(d.DeviceID.String, int(renewalCost), "domain_renewal", d.Domain); err != nil {
		// Insufficient credit — disable CF auto-renew and mark payment_failed.
		slog.Warn("scheduler: insufficient credit for domain renewal, marking payment_failed",
			"domain", d.Domain, "device", d.DeviceID.String, "cost_cents", renewalCost, "error", err)
		_ = s.registrar.UpdateDomainAutoRenew(cfAccountID, apiToken, d.Domain, false)
		_, _ = s.db.ExecContext(ctx,
			`UPDATE custom_domains SET status = 'payment_failed', auto_renew = FALSE WHERE id = $1`,
			d.ID)
		return
	}

	slog.Info("scheduler: domain renewed, credit deducted",
		"domain", d.Domain, "device", d.DeviceID.String, "cost_cents", renewalCost)
}

// retryPaymentFailed attempts to deduct credit again for a payment_failed domain.
// If it succeeds, re-enables CF auto-renew and sets status='active'.
func (s *Scheduler) retryPaymentFailed(ctx context.Context, d domainRow, apiToken, cfAccountID string) {
	if !d.DeviceID.Valid {
		return // no device linked — nothing to retry
	}
	renewalCost := int64(0)
	if d.RenewalCostCents.Valid {
		renewalCost = d.RenewalCostCents.Int64
	}
	if renewalCost <= 0 {
		return
	}

	if err := s.billing.DeductCredit(d.DeviceID.String, int(renewalCost), "domain_renewal", d.Domain); err != nil {
		slog.Debug("scheduler: payment_failed domain still has insufficient credit",
			"domain", d.Domain, "error", err)
		return
	}

	// Credit deducted successfully — re-enable auto-renew and mark active.
	_ = s.registrar.UpdateDomainAutoRenew(cfAccountID, apiToken, d.Domain, true)
	_, _ = s.db.ExecContext(ctx,
		`UPDATE custom_domains SET status = 'active', auto_renew = TRUE WHERE id = $1`,
		d.ID)
	slog.Info("scheduler: payment_failed domain recovered, credit deducted",
		"domain", d.Domain, "device", d.DeviceID.String, "cost_cents", renewalCost)
}

// revokeExpiredDomain handles a grace domain that has reached expiry: sets
// status='expired', deactivates the domain service credential, and re-provisions
// the subdomain fallback so the device gets a working hostname immediately.
func (s *Scheduler) revokeExpiredDomain(ctx context.Context, d domainRow) {
	_, _ = s.db.ExecContext(ctx,
		`UPDATE custom_domains SET status = 'expired' WHERE id = $1`, d.ID)

	if d.DeviceID.Valid {
		_, _ = s.db.ExecContext(ctx,
			`UPDATE service_credentials SET is_active = FALSE, revoked_at = $1
			 WHERE device_id = $2 AND service_type = 'domain'`,
			time.Now(), d.DeviceID.String)
		// Re-provision the subdomain fallback.
		provSvc := services.NewProvisioningService(s.db)
		if _, err := provSvc.Provision(d.DeviceID.String, "domain", ""); err != nil {
			slog.Warn("scheduler: failed to re-provision subdomain after expiry",
				"error", err, "device", d.DeviceID.String)
		}
	}
	slog.Info("scheduler: expired grace domain revoked, subdomain re-provisioned",
		"domain", d.Domain, "device", d.DeviceID.String)
}

// detectOrphans lists all domains in Cloudflare and logs any that are not in
// our custom_domains table with an active/grace status. Orphans are not
// auto-deleted (there is no CF API for domain deletion) — this is for
// operational visibility only.
func (s *Scheduler) detectOrphans(ctx context.Context, apiToken, cfAccountID string) {
	cfDomains, err := s.registrar.ListDomains(cfAccountID, apiToken)
	if err != nil {
		slog.Debug("scheduler: could not list CF domains for orphan check", "error", err)
		return
	}

	rows, err := s.db.QueryContext(ctx,
		`SELECT domain FROM custom_domains WHERE status IN ('active', 'grace')`)
	if err != nil {
		return
	}
	defer rows.Close()

	known := make(map[string]bool)
	for rows.Next() {
		var d string
		_ = rows.Scan(&d)
		known[d] = true
	}

	for _, cf := range cfDomains {
		if !known[cf.Name] {
			slog.Warn("scheduler: orphaned domain detected in Cloudflare — not in custom_domains or not active",
				"domain", cf.Name, "cf_status", cf.Status, "auto_renew", cf.AutoRenew)
		}
	}
}

// lookUpTunnelCredentials queries the service_providers table for the enabled
// tunnel provider and returns the API token and account ID.
func (s *Scheduler) lookUpTunnelCredentials(ctx context.Context) (apiToken, accountID string, err error) {
	var credentialsJSON, settingsJSON sql.NullString
	err = s.db.QueryRowContext(ctx,
		`SELECT credentials_json, settings_json FROM service_providers WHERE service = 'tunnel' AND enabled = TRUE LIMIT 1`,
	).Scan(&credentialsJSON, &settingsJSON)
	if err != nil {
		return "", "", err
	}
	var creds map[string]any
	json.Unmarshal([]byte(credentialsJSON.String), &creds)
	if t, ok := creds["api_token"].(string); ok {
		apiToken = t
	}
	var settings map[string]any
	json.Unmarshal([]byte(settingsJSON.String), &settings)
	if a, ok := settings["account_id"].(string); ok {
		accountID = a
	}
	return apiToken, accountID, nil
}

// parseDomainCostToCents converts a price string like "11.20" to cents (1120).
func parseDomainCostToCents(cost string) (int64, error) {
	f, err := strconv.ParseFloat(cost, 64)
	if err != nil {
		return 0, err
	}
	return int64(f * 100), nil
}
