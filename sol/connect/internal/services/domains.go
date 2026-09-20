package services

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/catalog"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// DomainCoordinator is the single owner of custom-domain ↔ device state.
//
// Every custom-domain transition (purchase, change, cancel, downgrade,
// use-subdomain, set-subdomain, device activation, scheduler expiry) goes
// through Reconcile, which computes the desired state from the database and
// applies it idempotently:
//
//   - Custom domain (status 'active') linked to the device becomes the
//     serving domain: DNS CNAME → tunnel, tunnel ingress, and the device's
//     domain credential (so Caddy serves it) are all ensured.
//   - Otherwise the device serves its plan subdomain: the previous custom
//     domain credential is revoked and the subdomain is provisioned.
//
// It also closes the orphan hole: Reconcile claims the account's first
// unassigned custom domain onto a device at activation, so a domain bought
// during onboarding before any device existed becomes linked and serving.
type DomainCoordinator struct {
	db    *sql.DB
	provs *ProvisioningService
}

func NewDomainCoordinator(db *sql.DB) *DomainCoordinator {
	return &DomainCoordinator{db: db, provs: NewProvisioningService(db)}
}

// Activation claims and reconciles a freshly-activated device.
// The stamped subdomain is already set on devices.subdomain by Activate.
func (s *DomainCoordinator) Activation(deviceID string) error {
	// Claim the account's first unassigned (device_id NULL) custom domain.
	// Bought during onboarding before the device existed → now link it so
	// it routes instead of renewing forever while serving nothing.
	var accountID string
	if err := s.db.QueryRow(`SELECT account_id FROM devices WHERE id = $1`, deviceID).Scan(&accountID); err != nil {
		return fmt.Errorf("device not found: %w", err)
	}
	var unassigned string
	err := s.db.QueryRow(
		`SELECT domain FROM custom_domains
		 WHERE account_id = $1 AND device_id IS NULL AND status IN ('active','grace')
		 ORDER BY purchased_at LIMIT 1`,
		accountID).Scan(&unassigned)
	if err == nil && unassigned != "" {
		if _, err := s.db.Exec(
			`UPDATE custom_domains SET device_id = $1 WHERE domain = $2`,
			deviceID, unassigned); err != nil {
			slog.Warn("activation: failed to claim unassigned domain", "error", err, "domain", unassigned, "device", deviceID)
		} else {
			slog.Info("activation: claimed unassigned domain", "domain", unassigned, "device", deviceID)
		}
	}

	return s.Reconcile(deviceID)
}

// Reconcile computes and applies the desired domain state for a device.
// Idempotent: safe to call repeatedly (activation, purchase, plan change,
// scheduler cycle, Connect status).
func (s *DomainCoordinator) Reconcile(deviceID string) error {
	var planID, accountID string
	var subdomain sql.NullString
	if err := s.db.QueryRow(
		`SELECT plan_id, account_id, subdomain FROM devices WHERE id = $1`, deviceID,
	).Scan(&planID, &accountID, &subdomain); err != nil {
		return fmt.Errorf("device not found: %w", err)
	}

	// The device's serving domain: the device's active custom domain (if any)
	// wins; otherwise the plan subdomain.
	var customDomain string
	err := s.db.QueryRow(
		`SELECT domain FROM custom_domains
		 WHERE device_id = $1 AND status = 'active'
		 ORDER BY purchased_at DESC LIMIT 1`,
		deviceID).Scan(&customDomain)
	if err != nil && err != sql.ErrNoRows {
		return err
	}

	if customDomain != "" {
		return s.applyCustomDomain(deviceID, customDomain)
	}

	// No active custom domain — serve the plan subdomain.
	if err := s.revokeDomainCredential(deviceID); err != nil {
		slog.Warn("reconcile: failed to revoke stale domain credential", "error", err, "device", deviceID)
	}
	sub := subdomain.String
	if sub == "" {
		sub = defaultSubdomain(deviceID)
	}
	_, err = s.provs.Provision(deviceID, "domain", "")
	if err != nil {
		return fmt.Errorf("could not provision subdomain: %w", err)
	}
	slog.Debug("reconcile: serving subdomain", "device", deviceID, "subdomain", sub)
	return nil
}

// applyCustomDomain ensures the device serves the given custom domain:
// DNS CNAME → tunnel, tunnel ingress entry, and the device's domain
// credential (so Caddy serves it). Skips CF calls when no tunnel is
// provisioned yet — scheduler reconciles once the tunnel comes up.
func (s *DomainCoordinator) applyCustomDomain(deviceID, domain string) error {

	// The device's domain credential — what the device reads to know which
	// domain to serve (Caddy defaults). This is also what the portal and the
	// device agree on as "current".
	creds := map[string]any{
		"domain":      domain,
		"provider":    "connect",
		"auto_https":  true,
		"dns_managed": false,
	}
	credsJSON, _ := json.Marshal(creds)
	if _, err := s.db.Exec(
		`INSERT INTO service_credentials (id, device_id, service_type, credentials_json, is_active)
		 VALUES ($1, $2, 'domain', $3, TRUE)
		 ON CONFLICT (device_id, service_type) DO UPDATE SET
		   credentials_json = excluded.credentials_json,
		   provisioned_at = CURRENT_TIMESTAMP,
		   is_active = TRUE`,
		security.GenerateID("cred"), deviceID, string(credsJSON)); err != nil {
		return fmt.Errorf("could not save domain credential: %w", err)
	}

	// CF DNS + ingress are best-effort; the scheduler reconciles.
	tunnelID := s.provs.findDeviceTunnelID(deviceID)
	if tunnelID == "" {
		slog.Debug("applyCustomDomain: no tunnel yet, skipping DNS/ingress", "domain", domain, "device", deviceID)
		return nil
	}
	s.ensureCustomDomainRoute(deviceID, domain, tunnelID)
	return nil
}

// ensureCustomDomainRoute creates the DNS CNAME and tunnel ingress rule for
// the custom domain, ignoring errors (reconciled by the scheduler).
func (s *DomainCoordinator) ensureCustomDomainRoute(deviceID, domain, tunnelID string) {
	prov, err := s.provs.providers.FindEnabled("dns")
	if err != nil || prov == nil {
		slog.Warn("ensureCustomDomainRoute: no DNS provider", "error", err, "device", deviceID)
		return
	}
	dnsToken := prov.Credential("api_token", "")
	zone := prov.Setting("zone", "")
	if dnsToken == "" || zone == "" {
		slog.Warn("ensureCustomDomainRoute: DNS provider not configured", "device", deviceID)
		return
	}

	cnameTarget := fmt.Sprintf("%s.cfargotunnel.com", tunnelID)
	if _, err := s.provs.dns.CreateCNAME(dnsToken, zone, domain, cnameTarget); err != nil {
		slog.Warn("ensureCustomDomainRoute: CNAME failed", "error", err, "domain", domain, "device", deviceID)
	} else {
		// Record that DNS is managed so the credential reflects reality.
		var credsJSON string
		_ = s.db.QueryRow(
			`SELECT credentials_json FROM service_credentials
			 WHERE device_id = $1 AND service_type = 'domain'`, deviceID).Scan(&credsJSON)
		if credsJSON != "" {
			var creds map[string]any
			if json.Unmarshal([]byte(credsJSON), &creds) == nil {
				creds["dns_managed"] = true
				upd, _ := json.Marshal(creds)
				_, _ = s.db.Exec(
					`UPDATE service_credentials SET credentials_json = $1
					 WHERE device_id = $2 AND service_type = 'domain'`,
					string(upd), deviceID)
			}
		}
	}

	// Tunnel ingress: ensure the custom domain routes to the device's Caddy.
	if tunnelProv, err := s.provs.providers.FindEnabled("tunnel"); err == nil && tunnelProv != nil {
		routes := []providers.IngressRoute{
			{Hostname: domain, Service: "http://localhost:80"},
		}
		if err := s.provs.tunnel.ConfigureIngressMulti(tunnelProv.Credential("account_id", ""), tunnelProv.Credential("api_token", ""), tunnelID, routes); err != nil {
			slog.Warn("ensureCustomDomainRoute: ingress failed", "error", err, "domain", domain, "device", deviceID)
		}
	}
}

// revokeDomainCredential deactivates the device's domain credential row.
func (s *DomainCoordinator) revokeDomainCredential(deviceID string) error {
	_, err := s.db.Exec(
		`UPDATE service_credentials SET is_active = FALSE, revoked_at = $1
		 WHERE device_id = $2 AND service_type = 'domain' AND is_active = TRUE`,
		time.Now(), deviceID)
	return err
}

// defaultSubdomain returns the historical device-ID-derived subdomain prefix.
func defaultSubdomain(deviceID string) string {
	if len(deviceID) >= 8 {
		return deviceID[len(deviceID)-8:]
	}
	return deviceID
}

// planDomainPattern returns the plan's wildcard subdomain pattern for a device.
func (s *DomainCoordinator) planDomainPattern(planID string) string {
	plan := catalog.PlanByID(planID)
	if plan == nil {
		plan = catalog.PlanByID("free")
	}
	return plan.Limits.Domain
}

// subdomainHostname builds the full hostname for a subdomain prefix under the
// device's plan domain.
func (s *DomainCoordinator) SubdomainHostname(sub, planID string) string {
	pattern := s.planDomainPattern(planID)
	if pattern == "" {
		return sub
	}
	return strings.Replace(pattern, "*", sub, 1)
}

// deviceSubdomain returns the device's raw subdomain prefix and full hostname.
func (s *DomainCoordinator) DeviceSubdomain(deviceID string) (string, string) {
	var raw sql.NullString
	var planID string
	_ = s.db.QueryRow(
		`SELECT subdomain, plan_id FROM devices WHERE id = $1`, deviceID).Scan(&raw, &planID)
	sub := raw.String
	if sub == "" {
		sub = defaultSubdomain(deviceID)
	}
	return sub, s.SubdomainHostname(sub, planID)
}

// servingDomain returns the device's currently-serving domain and whether it
// is a custom domain. This is the single reader for "what is my domain".
func (s *DomainCoordinator) ServingDomain(deviceID string) (string, bool, error) {
	var custom string
	err := s.db.QueryRow(
		`SELECT domain FROM custom_domains
		 WHERE device_id = $1 AND status = 'active'
		 ORDER BY purchased_at DESC LIMIT 1`, deviceID).Scan(&custom)
	if err == nil && custom != "" {
		return custom, true, nil
	}
	if err != nil && err != sql.ErrNoRows {
		return "", false, err
	}
	_, subdomain := s.DeviceSubdomain(deviceID)
	return subdomain, false, nil
}
