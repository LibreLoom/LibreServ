package services

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/catalog"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/smtp"
)

// ProvisioningService handles service credential provisioning.
type ProvisioningService struct {
	db        *sql.DB
	providers *providers.Service
	b2        *providers.B2Client
	resend    *providers.ResendClient
	dns       *providers.CloudflareClient
	tunnel    *providers.TunnelClient
}

// NewProvisioningService creates a provisioning service with default upstream clients.
func NewProvisioningService(db *sql.DB) *ProvisioningService {
	return &ProvisioningService{
		db:        db,
		providers: providers.NewService(db),
		b2:        providers.NewB2Client(nil),
		resend:    providers.NewResendClient(nil),
		dns:       providers.NewCloudflareClient(nil),
		tunnel:    providers.NewTunnelClient(nil),
	}
}

// NewProvisioningServiceWithClients creates a provisioning service with injectable clients (used in tests).
func NewProvisioningServiceWithClients(db *sql.DB, prov *providers.Service, b2 *providers.B2Client, resend *providers.ResendClient, dns *providers.CloudflareClient, tunnel *providers.TunnelClient) *ProvisioningService {
	return &ProvisioningService{
		db:        db,
		providers: prov,
		b2:        b2,
		resend:    resend,
		dns:       dns,
		tunnel:    tunnel,
	}
}

// Provision generates and stores credentials for a service.
func (s *ProvisioningService) Provision(deviceID, serviceType, clientIP string) (map[string]any, error) {
	// Enforce plan quotas before doing any real work.
	switch serviceType {
	case "backup", "tunnel", "smtp", "ai":
		_, allowed, err := billing.NewService(s.db).CheckQuota(deviceID, serviceType, 1)
		if err != nil {
			return nil, fmt.Errorf("could not check your plan quota. Please try again in a moment.")
		}
		if !allowed {
			return nil, fmt.Errorf("this service is not included in your current plan. Upgrade in Settings → Subscription to enable it.")
		}
	}
	// For domain service, check if custom domain credentials already exist
	// (e.g. from a domain purchase webhook). If so, return those instead
	// of generating a new subdomain.
	if serviceType == "domain" {
		var existingCreds string
		err := s.db.QueryRow(
			`SELECT credentials_json FROM service_credentials
			 WHERE device_id = $1 AND service_type = 'domain' AND is_active = TRUE`,
			deviceID).Scan(&existingCreds)
		if err == nil && existingCreds != "" {
			// Return existing credentials (custom domain was purchased)
			var creds map[string]any
			if json.Unmarshal([]byte(existingCreds), &creds) == nil {
				return creds, nil
			}
		}
	}
	creds, err := s.generateCredentials(deviceID, serviceType, clientIP)
	if err != nil {
		return nil, err
	}
	if creds == nil {
		return nil, fmt.Errorf("unknown service type: %s", serviceType)
	}

	credsJSON := mustJSON(creds)
	_, err = s.db.Exec(
		`INSERT INTO service_credentials (id, device_id, service_type, credentials_json, provisioned_at, is_active)
		 VALUES ($1, $2, $3, $4, $5, TRUE)
		 ON CONFLICT(device_id, service_type) DO UPDATE SET
		   credentials_json = excluded.credentials_json,
		   provisioned_at = excluded.provisioned_at,
		   is_active = TRUE`,
		security.GenerateID("cred"), deviceID, serviceType, credsJSON, time.Now())
	if err != nil {
		return nil, err
	}

	return creds, nil
}

// Revoke deactivates credentials for a service on a device.
func (s *ProvisioningService) Revoke(deviceID, serviceType string) error {
	_, err := s.db.Exec(
		"UPDATE service_credentials SET is_active = FALSE, revoked_at = $1 WHERE device_id = $2 AND service_type = $3",
		time.Now(), deviceID, serviceType)
	return err
}

// ListActive returns all active service credentials for a device.
func (s *ProvisioningService) ListActive(deviceID string) ([]string, error) {
	rows, err := s.db.Query(
		"SELECT service_type FROM service_credentials WHERE device_id = $1 AND is_active = TRUE", deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var services []string
	for rows.Next() {
		var svc string
		if err := rows.Scan(&svc); err != nil {
			return nil, err
		}
		services = append(services, svc)
	}
	return services, nil
}

func (s *ProvisioningService) generateCredentials(deviceID, service, clientIP string) (map[string]any, error) {
	sub := deviceID
	if len(deviceID) >= 8 {
		sub = deviceID[len(deviceID)-8:]
	}

	switch service {
	case "smtp":
		return s.generateSMTP(deviceID)
	case "domain":
		return s.generateDomain(deviceID, sub, clientIP)
	case "backup":
		return s.generateBackup(sub)
	case "tunnel":
		return s.generateTunnel(deviceID, sub)
	case "ai":
		baseURL := config.C.Inference.BaseURL
		if baseURL == "" {
			baseURL = "https://inference.neuralwatt.dev/v1"
		}
		return map[string]any{
			"ai": map[string]any{
				"base_url": baseURL,
				"api_key":  fmt.Sprintf("nw-sk-%s-%s", sub, security.RandomPassword(24)),
				"format":   "openai",
			},
		}, nil
	default:
		return nil, nil
	}
}

// generateSMTP provisions SMTP credentials for the device's Connect SMTP relay.
// Each account has a username and smtp_password stored in customer_accounts.
// The device's local SMTP relay will use these credentials to authenticate
// with Connect's SMTP server, which forwards to Resend.
func (s *ProvisioningService) generateSMTP(deviceID string) (map[string]any, error) {
	// Look up the account's username and smtp_password via the device
	var username, smtpPassword string
	err := s.db.QueryRow(
		`SELECT ca.username, ca.smtp_password
		 FROM customer_accounts ca
		 JOIN devices d ON d.account_id = ca.id
		 WHERE d.id = $1 AND ca.is_active = TRUE`,
		deviceID).Scan(&username, &smtpPassword)
	if err != nil {
		return nil, fmt.Errorf("could not find SMTP credentials for this device. Make sure your account has a username set.")
	}
	if username == "" || smtpPassword == "" {
		return nil, fmt.Errorf("your account does not have SMTP credentials set up. Please contact support.")
	}

	// Connect SMTP relay address — defaults to the server's public address
	relayHost := config.C.Server.BaseURL
	// Strip protocol and path to get just the host
	relayHost = strings.TrimPrefix(relayHost, "https://")
	relayHost = strings.TrimPrefix(relayHost, "http://")
	relayHost = strings.Split(relayHost, "/")[0]
	if relayHost == "" {
		relayHost = "connect.serv.libreloom.org"
	}

	relayPort := 2525

	fromAddr := smtp.SendingAddress(username)

	return map[string]any{
		"smtp": map[string]any{
			"host":     relayHost,
			"port":     relayPort,
			"username": username,
			"password": smtpPassword,
			"from":     fromAddr,
			"use_tls":  false, // Connect SMTP relay uses plaintext (device connects over TLS tunnel)
		},
	}, nil
}

func (s *ProvisioningService) generateBackup(sub string) (map[string]any, error) {
	prov, err := s.providers.FindEnabled("backup")
	if err != nil {
		return nil, fmt.Errorf("could not look up backup provider: %w", err)
	}

	// Prefer a configured Backblaze B2 provider; fall back to legacy S3 config.
	if prov != nil && prov.Credential("account_id", "") != "" && prov.Credential("application_key", "") != "" {
		bucketPrefix := prov.Setting("bucket_prefix", "libreserv-backup")
		bucketName := fmt.Sprintf("%s-%s", bucketPrefix, sub)
		creds, err := s.b2.ProvisionBucket(prov.Credential("account_id", ""), prov.Credential("application_key", ""), bucketName)
		if err != nil {
			return nil, fmt.Errorf("could not create backup bucket: %w", err)
		}
		return map[string]any{
			"backup": map[string]any{
				"repo_type": "s3",
				"repo_path": fmt.Sprintf("s3:https://%s/%s", creds.Endpoint, creds.BucketName),
				"password":  security.RandomPassword(32),
				"env": map[string]string{
					"AWS_ACCESS_KEY_ID":     creds.KeyID,
					"AWS_SECRET_ACCESS_KEY": creds.Key,
				},
			},
		}, nil
	}

	if config.C.Backup.Endpoint == "" {
		return nil, fmt.Errorf("no backup provider is configured. Add one in the admin portal under Service Providers.")
	}

	return map[string]any{
		"backup": map[string]any{
			"repo_type": "s3",
			"repo_path": fmt.Sprintf("s3:https://%s/%s/%s",
				config.C.Backup.Endpoint, config.C.Backup.BucketPrefix, sub),
			"password": security.RandomPassword(32),
			"env": map[string]string{
				"AWS_ACCESS_KEY_ID":     sub + security.RandomString(8),
				"AWS_SECRET_ACCESS_KEY": security.RandomPassword(40),
			},
		},
	}, nil
}

func (s *ProvisioningService) generateDomain(deviceID, sub, clientIP string) (map[string]any, error) {
	var planID string
	if err := s.db.QueryRow("SELECT plan_id FROM devices WHERE id = $1", deviceID).Scan(&planID); err != nil {
		return nil, fmt.Errorf("could not find your device plan: %w", err)
	}

	plan := catalog.PlanByID(planID)
	if plan == nil {
		plan = catalog.PlanByID("free")
	}

	zone := strings.Replace(plan.Limits.Domain, "*", sub, 1)

	prov, err := s.providers.FindEnabled("dns")
	if err != nil {
		return nil, fmt.Errorf("could not look up DNS provider: %w", err)
	}
	dnsManaged := false
	if prov != nil && prov.Credential("api_token", "") != "" {
		recordName := sub
		if parent := prov.Setting("zone", ""); parent != "" {
			zone = parent
		}

		// Check if the device has a provisioned tunnel. If so, create a
		// CNAME pointing at the tunnel instead of an A record to the IP.
		tunnelID := s.findDeviceTunnelID(deviceID)
		if tunnelID != "" {
			cnameTarget := fmt.Sprintf("%s.cfargotunnel.com", tunnelID)
			dnsManaged, _ = s.dns.CreateCNAME(
				prov.Credential("api_token", ""),
				zone,
				recordName,
				cnameTarget,
			)
		} else {
			// No tunnel — fall back to A record with the device IP.
			ip := clientIP
			if ip == "" {
				ip = "127.0.0.1"
			}
			dnsManaged, _ = s.dns.CreateRecord(
				prov.Credential("api_token", ""),
				"",
				zone,
				recordName,
				"A",
				ip,
				600,
			)
		}
	} else if config.C.DNS.Provider != "" && config.C.DNS.APIToken != "" && config.C.DNS.Zone != "" {
		// Legacy fallback: we only know the zone, so use the full subdomain as the record name.
		ip := clientIP
		if ip == "" {
			ip = "127.0.0.1"
		}
		zone = config.C.DNS.Zone
		dnsManaged, _ = s.dns.CreateRecord(
			config.C.DNS.APIToken,
			"",
			zone,
			sub,
			"A",
			ip,
			600,
		)
	}

	return map[string]any{
		"domain": map[string]any{
			"domain":      zone,
			"provider":    "connect",
			"auto_https":  true,
			"dns_managed": dnsManaged,
		},
	}, nil
}

// generateTunnel creates a Cloudflare Tunnel for the device and returns the
// tunnel token the device uses to run cloudflared. The tunnel is named after
// the device for easy identification in the Cloudflare dashboard.
// The tunnel's initial ingress routes the device's base hostname to the
// device's Caddy (http://localhost:80), which handles app-level routing.
func (s *ProvisioningService) generateTunnel(deviceID, sub string) (map[string]any, error) {
	prov, err := s.providers.FindEnabled("tunnel")
	if err != nil {
		return nil, fmt.Errorf("could not look up tunnel provider: %w", err)
	}

	if prov == nil || prov.Credential("api_token", "") == "" || prov.Credential("account_id", "") == "" {
		return nil, fmt.Errorf("tunnel provider is not configured. Add a Cloudflare tunnel provider in the admin portal under Service Providers (service: tunnel).")
	}

	accountID := prov.Credential("account_id", "")
	apiToken := prov.Credential("api_token", "")
	tunnelName := fmt.Sprintf("libreserv-%s", sub)

	creds, err := s.tunnel.CreateTunnel(accountID, apiToken, tunnelName)
	if err != nil {
		return nil, fmt.Errorf("could not create tunnel: %w", err)
	}

	// Configure initial ingress with the device base hostname.
	// The device's Caddy (http://localhost:80) handles routing to individual
	// app containers based on the Host header.
	baseHostname := s.deviceHostname(deviceID, sub)
	if baseHostname != "" {
		_ = s.tunnel.ConfigureIngress(accountID, apiToken, creds.TunnelID, baseHostname, "http://localhost:80")
	}

	return map[string]any{
		"tunnel": map[string]any{
			"provider":     "cloudflare",
			"tunnel_token": creds.Token,
			"tunnel_id":    creds.TunnelID,
		},
	}, nil
}

// deviceHostname returns the full hostname for a device based on its plan.
// e.g. "abc12345.free.servers.libreloom.org" for free plan.
func (s *ProvisioningService) deviceHostname(deviceID, sub string) string {
	var planID string
	if err := s.db.QueryRow("SELECT plan_id FROM devices WHERE id = $1", deviceID).Scan(&planID); err != nil {
		return ""
	}
	plan := catalog.PlanByID(planID)
	if plan == nil {
		plan = catalog.PlanByID("free")
	}
	return strings.Replace(plan.Limits.Domain, "*", sub, 1)
}

// RegisterRoute adds a public hostname to the device's tunnel and creates a
// DNS CNAME pointing to the tunnel. Cloudflare auto-provisions an SSL cert
// for the hostname as a tunnel public hostname — no ACM needed.
// The hostname must be a subdomain of the device's base domain.
// Called by the device when installing an app (e.g. Nextcloud at
// "nextcloud.user.free.servers.libreloom.org").
func (s *ProvisioningService) RegisterRoute(deviceID, hostname string) error {
	if hostname == "" {
		return fmt.Errorf("hostname is required")
	}

	// Look up the device's tunnel credentials
	tunnelID := s.findDeviceTunnelID(deviceID)
	if tunnelID == "" {
		return fmt.Errorf("no tunnel is provisioned for this device. Enable Tunnel Access in your Connect settings first.")
	}

	// Get tunnel provider credentials
	tunnelProv, err := s.providers.FindEnabled("tunnel")
	if err != nil || tunnelProv == nil {
		return fmt.Errorf("tunnel provider is not configured")
	}
	accountID := tunnelProv.Credential("account_id", "")
	apiToken := tunnelProv.Credential("api_token", "")

	// Get DNS provider
	dnsProv, err := s.providers.FindEnabled("dns")
	if err != nil || dnsProv == nil {
		return fmt.Errorf("DNS provider is not configured")
	}
	dnsToken := dnsProv.Credential("api_token", "")
	zone := dnsProv.Setting("zone", "")
	if zone == "" {
		return fmt.Errorf("DNS zone is not configured")
	}

	// Create DNS CNAME: hostname → {tunnelID}.cfargotunnel.com
	cnameTarget := fmt.Sprintf("%s.cfargotunnel.com", tunnelID)
	if _, err := s.dns.CreateCNAME(dnsToken, zone, hostname, cnameTarget); err != nil {
		return fmt.Errorf("could not create DNS record for %s: %w", hostname, err)
	}

	// Rebuild tunnel ingress with all registered routes + base hostname
	routes, err := s.listRouteHostnames(deviceID)
	if err != nil {
		return fmt.Errorf("could not list existing routes: %w", err)
	}

	// Add the base hostname first (if known), then all app routes
	var sub string
	if len(deviceID) >= 8 {
		sub = deviceID[len(deviceID)-8:]
	}
	baseHostname := s.deviceHostname(deviceID, sub)

	var ingressRoutes []providers.IngressRoute
	if baseHostname != "" {
		ingressRoutes = append(ingressRoutes, providers.IngressRoute{
			Hostname: baseHostname,
			Service:  "http://localhost:80",
		})
	}
	for _, h := range routes {
		if h != baseHostname {
			ingressRoutes = append(ingressRoutes, providers.IngressRoute{
				Hostname: h,
				Service:  "http://localhost:80",
			})
		}
	}
	// Add the new route (if not already in the list)
	alreadyExists := false
	for _, h := range routes {
		if h == hostname {
			alreadyExists = true
			break
		}
	}
	if !alreadyExists {
		ingressRoutes = append(ingressRoutes, providers.IngressRoute{
			Hostname: hostname,
			Service:  "http://localhost:80",
		})
	}

	if err := s.tunnel.ConfigureIngressMulti(accountID, apiToken, tunnelID, ingressRoutes); err != nil {
		return fmt.Errorf("could not update tunnel routing: %w", err)
	}

	// Store the route in the database
	_, err = s.db.Exec(
		`INSERT INTO device_routes (id, device_id, hostname) VALUES ($1, $2, $3)
		 ON CONFLICT (device_id, hostname) DO NOTHING`,
		security.GenerateID("route"), deviceID, hostname)
	return err
}

// UnregisterRoute removes a public hostname from the device's tunnel and
// deletes the DNS CNAME. Called by the device when removing an app.
func (s *ProvisioningService) UnregisterRoute(deviceID, hostname string) error {
	if hostname == "" {
		return fmt.Errorf("hostname is required")
	}

	// Delete the DNS record
	dnsProv, err := s.providers.FindEnabled("dns")
	if err == nil && dnsProv != nil {
		_ = s.dns.DeleteRecordByName(dnsProv.Credential("api_token", ""), dnsProv.Setting("zone", ""), hostname)
	}

	// Remove from database
	_, _ = s.db.Exec("DELETE FROM device_routes WHERE device_id = $1 AND hostname = $2", deviceID, hostname)

	// Rebuild tunnel ingress without the removed route
	tunnelID := s.findDeviceTunnelID(deviceID)
	if tunnelID != "" {
		tunnelProv, err := s.providers.FindEnabled("tunnel")
		if err == nil && tunnelProv != nil {
			accountID := tunnelProv.Credential("account_id", "")
			apiToken := tunnelProv.Credential("api_token", "")

			routes, _ := s.listRouteHostnames(deviceID)

			var sub string
			if len(deviceID) >= 8 {
				sub = deviceID[len(deviceID)-8:]
			}
			baseHostname := s.deviceHostname(deviceID, sub)

			var ingressRoutes []providers.IngressRoute
			if baseHostname != "" {
				ingressRoutes = append(ingressRoutes, providers.IngressRoute{
					Hostname: baseHostname,
					Service:  "http://localhost:80",
				})
			}
			for _, h := range routes {
				if h != baseHostname && h != hostname {
					ingressRoutes = append(ingressRoutes, providers.IngressRoute{
						Hostname: h,
						Service:  "http://localhost:80",
					})
				}
			}

			if len(ingressRoutes) > 0 {
				_ = s.tunnel.ConfigureIngressMulti(accountID, apiToken, tunnelID, ingressRoutes)
			}
		}
	}

	return nil
}

// listRouteHostnames returns all registered route hostnames for a device.
func (s *ProvisioningService) listRouteHostnames(deviceID string) ([]string, error) {
	rows, err := s.db.Query(
		"SELECT hostname FROM device_routes WHERE device_id = $1 ORDER BY created_at", deviceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var hostnames []string
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			return nil, err
		}
		hostnames = append(hostnames, h)
	}
	return hostnames, nil
}

// findDeviceTunnelID looks up the tunnel ID for a device from the
// service_credentials table. Returns empty string if no active tunnel exists.
func (s *ProvisioningService) findDeviceTunnelID(deviceID string) string {
	var credsJSON string
	err := s.db.QueryRow(
		`SELECT credentials_json FROM service_credentials
		 WHERE device_id = $1 AND service_type = 'tunnel' AND is_active = TRUE`,
		deviceID).Scan(&credsJSON)
	if err != nil {
		return ""
	}
	var creds struct {
		TunnelID string `json:"tunnel_id"`
	}
	if json.Unmarshal([]byte(credsJSON), &creds) != nil {
		return ""
	}
	return creds.TunnelID
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
