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
		return s.generateSMTP(sub)
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

func (s *ProvisioningService) generateSMTP(sub string) (map[string]any, error) {
	prov, err := s.providers.FindEnabled("smtp")
	if err != nil {
		return nil, fmt.Errorf("could not look up email provider: %w", err)
	}

	// Prefer a configured Resend provider; fall back to legacy SMTP config.
	if prov != nil && prov.Credential("api_key", "") != "" {
		smtp, err := s.resend.CreateAPIKey(prov.Credential("api_key", ""), fmt.Sprintf("libreserv-%s", sub))
		if err != nil {
			return nil, fmt.Errorf("could not create email sending key: %w", err)
		}
		return map[string]any{
			"smtp": map[string]any{
				"host":     smtp.Host,
				"port":     smtp.Port,
				"username": smtp.Username,
				"password": smtp.Password,
				"from":     fmt.Sprintf("server@%s.servers.libreloom.org", sub),
				"use_tls":  true,
			},
		}, nil
	}

	if config.C.SMTP.Host == "" {
		return nil, fmt.Errorf("no email provider is configured. Add one in the admin portal under Service Providers.")
	}

	return map[string]any{
		"smtp": map[string]any{
			"host":     config.C.SMTP.Host,
			"port":     config.C.SMTP.Port,
			"username": config.C.SMTP.Username,
			"password": config.C.SMTP.Password,
			"from":     config.C.SMTP.From,
			"use_tls":  config.C.SMTP.UseTLS,
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

	return map[string]any{
		"tunnel": map[string]any{
			"provider":     "cloudflare",
			"tunnel_token": creds.Token,
			"tunnel_id":    creds.TunnelID,
		},
	}, nil
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
