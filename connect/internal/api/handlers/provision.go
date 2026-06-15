package handlers

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
)

// ProvisionHandler handles service provisioning and plan info.
type ProvisionHandler struct {
	db *sql.DB
}

func NewProvisionHandler(db *sql.DB) *ProvisionHandler {
	return &ProvisionHandler{db: db}
}

// Info returns the public plan catalog.
func (h *ProvisionHandler) Info(w http.ResponseWriter, r *http.Request) {
	plans := []map[string]any{
		{"id": "free", "name": "Connect Free", "description": "Get started with basic services. No credit card required.", "price_monthly": 0},
		{"id": "one", "name": "Connect One", "description": "All services, unlimited. Fixed monthly price.", "price_monthly": 1500},
		{"id": "payg", "name": "Connect PAYG", "description": "All services, pay for what you use.", "price_monthly": 0},
	}

	planLimits := map[string]map[string]int{
		"free": {"max_emails_per_day": 30, "tunnel_mbps": 1, "tunnel_gb_per_mo": 1, "ai_messages_per_mo": 50, "backup_gb": 0},
		"one":  {"max_emails_per_day": 0, "tunnel_mbps": 100, "tunnel_gb_per_mo": 0, "ai_messages_per_mo": 0, "backup_gb": 0},
		"payg": {"max_emails_per_day": 0, "tunnel_mbps": 100, "tunnel_gb_per_mo": 0, "ai_messages_per_mo": 0, "backup_gb": 0},
	}

	JSON(w, http.StatusOK, map[string]any{
		"plans":       plans,
		"plan_limits": planLimits,
	})
}

// Provision generates credentials for a single service.
func (h *ProvisionHandler) Provision(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Service string `json:"service"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request")
		return
	}

	deviceID := middleware.GetDeviceID(r.Context())
	if deviceID == "" {
		JSONError(w, http.StatusUnauthorized, "device authentication required")
		return
	}
	creds := h.generateCredentials(deviceID, req.Service)

	_, _ = h.db.ExecContext(r.Context(),
		`INSERT INTO service_credentials (id, device_id, service_type, credentials_json, provisioned_at, is_active)
		 VALUES (?, ?, ?, ?, ?, 1)
		 ON CONFLICT(device_id, service_type) DO UPDATE SET
		   credentials_json = excluded.credentials_json,
		   provisioned_at = excluded.provisioned_at,
		   is_active = 1`,
		fmt.Sprintf("cred_%s_%s", deviceID, req.Service), deviceID, req.Service, mustJSON(creds), time.Now())

	JSON(w, http.StatusOK, creds)
}

func (h *ProvisionHandler) generateCredentials(deviceID, service string) map[string]any {
	sub := deviceID
	if len(deviceID) >= 8 {
		sub = deviceID[len(deviceID)-8:]
	}

	switch service {
	case "smtp":
		return map[string]any{
			"smtp": map[string]any{
				"host":     "smtp.libreloom.org",
				"port":     587,
				"username": fmt.Sprintf("server-%s", sub),
				"password": randomPassword(24),
				"from":     fmt.Sprintf("server@%s.servers.libreloom.org", sub),
				"use_tls":  true,
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
				"repo_path": fmt.Sprintf("s3:https://s3.libreloom.org/libreserv-backup/%s", sub),
				"password":  randomPassword(32),
				"env": map[string]string{
					"AWS_ACCESS_KEY_ID":     sub + "AKIA",
					"AWS_SECRET_ACCESS_KEY": randomPassword(40),
				},
			},
		}
	case "tunnel":
		return map[string]any{
			"tunnel": map[string]any{
				"provider": "connect",
				"token":    fmt.Sprintf("tunnel-%s-%s", sub, randomPassword(16)),
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
				"api_key":  fmt.Sprintf("nw-sk-%s-%s", sub, randomPassword(24)),
				"format":   "openai",
			},
		}
	default:
		return map[string]any{}
	}
}

func mustJSON(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func randomPassword(n int) string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	for i := range b {
		b[i] = chars[i%len(chars)]
	}
	return string(b)
}
