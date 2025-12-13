package network

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"time"
)

// ACMERequest holds data for requesting a certificate.
type ACMERequest struct {
	Domain  string `json:"domain"`
	Email   string `json:"email"`
	Backend string `json:"backend,omitempty"` // optional backend to route during cert issuance
	AppID   string `json:"app_id,omitempty"`  // optional app reference for backend lookup
	// BackendIndex selects a backend from the app's known backends (primary=0). Ignored if Backend is set.
	BackendIndex int `json:"backend_index,omitempty"`
	// BackendName selects a named backend (e.g., "ui", "api") from the app definition. Ignored if Backend is set.
	BackendName string `json:"backend_name,omitempty"`
}

// ACMEManager is a placeholder for integrating with Caddy's API or acme.sh.
type ACMEManager struct {
	adminAPI   string
	configPath string
	client     *http.Client
	auto       bool
}

func NewACMEManager(adminAPI, configPath string) *ACMEManager {
	return &ACMEManager{
		adminAPI:   adminAPI,
		configPath: configPath,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// WithAuto toggles automatic issuance after route creation.
func (a *ACMEManager) WithAuto(enable bool) *ACMEManager {
	a.auto = enable
	return a
}

// Issue triggers ACME by reloading Caddy config via Admin API using the current Caddyfile.
// Assumes Caddyfile is already configured for the desired domain/automation.
func (a *ACMEManager) Issue(ctx context.Context, req ACMERequest) error {
	if req.Domain == "" || req.Email == "" {
		return fmt.Errorf("domain and email required")
	}
	if a.adminAPI == "" || a.configPath == "" {
		return fmt.Errorf("caddy admin API or config path not configured")
	}

	// Quick health check
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	healthReq, _ := http.NewRequestWithContext(checkCtx, http.MethodGet, a.adminAPI+"/config/", nil)
	resp, err := a.client.Do(healthReq)
	if err != nil {
		return fmt.Errorf("caddy admin unreachable: %w", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("caddy admin returned %d", resp.StatusCode)
	}

	// Reload config to force Caddy to manage certs for configured domains.
	content, err := os.ReadFile(a.configPath)
	if err != nil {
		return fmt.Errorf("read caddyfile: %w", err)
	}
	loadReq, err := http.NewRequestWithContext(ctx, http.MethodPost, a.adminAPI+"/load", bytes.NewReader(content))
	if err != nil {
		return err
	}
	loadReq.Header.Set("Content-Type", "text/caddyfile")
	loadResp, err := a.client.Do(loadReq)
	if err != nil {
		return fmt.Errorf("caddy load failed: %w", err)
	}
	defer loadResp.Body.Close()
	if loadResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(loadResp.Body)
		return fmt.Errorf("caddy load failed: %s", string(body))
	}

	log.Printf("ACME request submitted for %s via Caddy Admin API", req.Domain)
	if !a.auto {
		return nil
	}
	return a.pollIssued(ctx, req.Domain)
}

// pollIssued polls Caddy's automation metrics for issuance success/failure.
func (a *ACMEManager) pollIssued(ctx context.Context, domain string) error {
	// best-effort polling for ~30s
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(3 * time.Second):
		}
		// query certificates endpoint
		url := a.adminAPI + "/certificates"
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
		resp, err := a.client.Do(req)
		if err != nil {
			continue
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode == http.StatusOK && bytes.Contains(body, []byte(domain)) {
			return nil
		}
	}
	return fmt.Errorf("acme issuance not confirmed for %s (timed out)", domain)
}
