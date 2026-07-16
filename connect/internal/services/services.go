package services

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// ProvisioningService handles service credential provisioning.
type ProvisioningService struct {
	db *sql.DB
}

// NewProvisioningService creates a provisioning service.
func NewProvisioningService(db *sql.DB) *ProvisioningService {
	return &ProvisioningService{db: db}
}

// Provision generates and stores credentials for a service.
func (s *ProvisioningService) Provision(deviceID, serviceType string) (map[string]any, error) {
	creds := s.generateCredentials(deviceID, serviceType)
	if creds == nil {
		return nil, fmt.Errorf("unknown service type: %s", serviceType)
	}

	credsJSON := mustJSON(creds)
	_, err := s.db.Exec(
		`INSERT INTO service_credentials (id, device_id, service_type, credentials_json, provisioned_at, is_active)
		 VALUES (?, ?, ?, ?, ?, 1)
		 ON CONFLICT(device_id, service_type) DO UPDATE SET
		   credentials_json = excluded.credentials_json,
		   provisioned_at = excluded.provisioned_at,
		   is_active = 1`,
		security.GenerateID("cred"), deviceID, serviceType, credsJSON, time.Now())
	if err != nil {
		return nil, err
	}

	return creds, nil
}

// Revoke deactivates credentials for a service on a device.
func (s *ProvisioningService) Revoke(deviceID, serviceType string) error {
	_, err := s.db.Exec(
		"UPDATE service_credentials SET is_active = 0, revoked_at = ? WHERE device_id = ? AND service_type = ?",
		time.Now(), deviceID, serviceType)
	return err
}

// ListActive returns all active service credentials for a device.
func (s *ProvisioningService) ListActive(deviceID string) ([]string, error) {
	rows, err := s.db.Query(
		"SELECT service_type FROM service_credentials WHERE device_id = ? AND is_active = 1", deviceID)
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

func (s *ProvisioningService) generateCredentials(deviceID, service string) map[string]any {
	sub := deviceID
	if len(deviceID) >= 8 {
		sub = deviceID[len(deviceID)-8:]
	}

	switch service {
	case "smtp":
		return map[string]any{
			"smtp": map[string]any{
				"host":     config.C.SMTP.Host,
				"port":     config.C.SMTP.Port,
				"username": fmt.Sprintf("server-%s", sub),
				"password": security.RandomPassword(24),
				"from":     fmt.Sprintf("server@%s.servers.libreloom.org", sub),
				"use_tls":  config.C.SMTP.UseTLS,
			},
		}
	case "domain":
		return map[string]any{
			"domain": map[string]any{
				"domain":     fmt.Sprintf("%s.servers.libreloom.org", sub),
				"provider":   "connect",
				"auto_https": true,
			},
		}
	case "backup":
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
		}
	case "tunnel":
		return map[string]any{
			"tunnel": map[string]any{
				"provider": "connect",
				"token":    fmt.Sprintf("tunnel-%s-%s", sub, security.RandomPassword(16)),
			},
		}
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
		}
	default:
		return nil
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}
