package network

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
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
	external   ExternalACMEConfig
	metrics    *monitoring.CaddyMetrics
}

// NewACMEManager creates a new ACME manager.
func NewACMEManager(adminAPI, configPath string) *ACMEManager {
	return &ACMEManager{
		adminAPI:   adminAPI,
		configPath: configPath,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// ExternalACMEConfig configures external ACME issuance (lego).
type ExternalACMEConfig struct {
	Enabled     bool              `json:"enabled"`
	UseDocker   bool              `json:"use_docker"`
	DockerImage string            `json:"docker_image"`
	DataPath    string            `json:"data_path"`
	DNSProvider string            `json:"dns_provider"`
	DNSEnv      map[string]string `json:"dns_env"`
	Email       string            `json:"email"`
	Staging     bool              `json:"staging"`
	CADirURL    string            `json:"ca_dir_url"`
	KeyType     string            `json:"key_type"`
	CertsPath   string            `json:"certs_path"`
}

// WithAuto toggles automatic issuance after route creation.
func (a *ACMEManager) WithAuto(enable bool) *ACMEManager {
	a.auto = enable
	return a
}

// WithExternal sets external ACME config for DNS-01 issuance.
func (a *ACMEManager) WithExternal(cfg ExternalACMEConfig) *ACMEManager {
	a.external = cfg
	return a
}

// WithMetrics sets the metrics collector for ACME operations
func (a *ACMEManager) WithMetrics(metrics *monitoring.CaddyMetrics) *ACMEManager {
	a.metrics = metrics
	return a
}

// ExternalEnabled reports whether external ACME is enabled.
func (a *ACMEManager) ExternalEnabled() bool {
	return a.external.Enabled
}

// Issue triggers ACME by reloading Caddy config via Admin API using the current Caddyfile.
// Assumes Caddyfile is already configured for the desired domain/automation.
func (a *ACMEManager) Issue(ctx context.Context, req ACMERequest) error {
	start := time.Now()
	certType := "auto"

	// External DNS-01 issuance via lego (preferred when configured).
	if a.external.Enabled {
		certType = "external"
		if req.Domain == "" {
			if a.metrics != nil {
				a.metrics.RecordCertIssuance(false, certType, time.Since(start))
			}
			return fmt.Errorf("domain required")
		}
		err := a.issueExternalDNS01(ctx, req.Domain, req.Email)
		if a.metrics != nil {
			a.metrics.RecordCertIssuance(err == nil, certType, time.Since(start))
		}
		return err
	}
	if req.Domain == "" || req.Email == "" {
		if a.metrics != nil {
			a.metrics.RecordCertIssuance(false, certType, time.Since(start))
		}
		return fmt.Errorf("domain and email required")
	}

	if a.adminAPI == "" || a.configPath == "" {
		if a.metrics != nil {
			a.metrics.RecordCertIssuance(false, certType, time.Since(start))
		}
		return fmt.Errorf("caddy admin API or config path not configured")
	}

	// Quick health check
	checkCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	healthReq, _ := http.NewRequestWithContext(checkCtx, http.MethodGet, a.adminAPI+"/config/", nil)
	resp, err := a.client.Do(healthReq)
	if err != nil {
		if a.metrics != nil {
			a.metrics.RecordCertIssuance(false, certType, time.Since(start))
		}
		return fmt.Errorf("caddy admin unreachable: %w", err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		if a.metrics != nil {
			a.metrics.RecordCertIssuance(false, certType, time.Since(start))
		}
		return fmt.Errorf("caddy admin returned %d", resp.StatusCode)
	}

	// Reload config to force Caddy to manage certs for configured domains.
	content, err := os.ReadFile(a.configPath)
	if err != nil {
		if a.metrics != nil {
			a.metrics.RecordCertIssuance(false, certType, time.Since(start))
		}
		return fmt.Errorf("read caddyfile: %w", err)
	}
	loadReq, err := http.NewRequestWithContext(ctx, http.MethodPost, a.adminAPI+"/load", bytes.NewReader(content))
	if err != nil {
		if a.metrics != nil {
			a.metrics.RecordCertIssuance(false, certType, time.Since(start))
		}
		return err
	}
	loadReq.Header.Set("Content-Type", "text/caddyfile")
	loadResp, err := a.client.Do(loadReq)
	if err != nil {
		if a.metrics != nil {
			a.metrics.RecordCertIssuance(false, certType, time.Since(start))
		}
		return fmt.Errorf("caddy load failed: %w", err)
	}
	defer loadResp.Body.Close()
	if loadResp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(loadResp.Body)
		if a.metrics != nil {
			a.metrics.RecordCertIssuance(false, certType, time.Since(start))
		}
		return fmt.Errorf("caddy load failed: %s", string(body))
	}

	log.Printf("ACME request submitted for %s via Caddy Admin API", req.Domain)
	if !a.auto {
		if a.metrics != nil {
			a.metrics.RecordCertIssuance(true, certType, time.Since(start))
		}
		return nil
	}
	err = a.pollIssued(ctx, req.Domain)
	if a.metrics != nil {
		a.metrics.RecordCertIssuance(err == nil, certType, time.Since(start))
	}
	return err
}

func (a *ACMEManager) issueExternalDNS01(ctx context.Context, domain, email string) error {
	cfg := a.external
	if cfg.DNSProvider == "" {
		return fmt.Errorf("external acme dns_provider is required")
	}
	if cfg.CertsPath == "" {
		return fmt.Errorf("external acme certs_path is required")
	}
	if cfg.DataPath == "" {
		cfg.DataPath = "./data/acme"
	}
	if cfg.DockerImage == "" {
		cfg.DockerImage = "goacme/lego:latest"
	}
	if cfg.KeyType == "" {
		cfg.KeyType = "rsa2048"
	}
	if strings.TrimSpace(email) == "" {
		if strings.TrimSpace(cfg.Email) != "" {
			email = cfg.Email
		} else {
			return fmt.Errorf("email required")
		}
	}

	_ = os.MkdirAll(cfg.DataPath, 0o755)
	_ = os.MkdirAll(cfg.CertsPath, 0o755)

	// Run lego to obtain/renew the cert into cfg.DataPath/certificates/.
	if cfg.UseDocker {
		if err := a.runLegoDocker(ctx, cfg, domain, email); err != nil {
			return err
		}
	} else {
		if err := a.runLegoBinary(ctx, cfg, domain, email); err != nil {
			return err
		}
	}

	// Copy outputs to the canonical Caddy cert dir layout:
	// <certs_path>/<safeDomain>/fullchain.pem + privkey.pem
	srcCrt := filepath.Join(cfg.DataPath, "certificates", domain+".crt")
	srcKey := filepath.Join(cfg.DataPath, "certificates", domain+".key")
	if !fileExists(srcCrt) || !fileExists(srcKey) {
		return fmt.Errorf("lego did not produce expected files: %s / %s", srcCrt, srcKey)
	}
	dstDir := filepath.Join(cfg.CertsPath, safeDomainDir(domain))
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		return fmt.Errorf("create cert dir: %w", err)
	}
	if err := copyFile(srcCrt, filepath.Join(dstDir, "fullchain.pem"), 0o644); err != nil {
		return fmt.Errorf("copy fullchain: %w", err)
	}
	if err := copyFile(srcKey, filepath.Join(dstDir, "privkey.pem"), 0o600); err != nil {
		return fmt.Errorf("copy privkey: %w", err)
	}

	log.Printf("External ACME issued cert for %s (dns-01 via lego)", domain)
	return nil
}

func (a *ACMEManager) runLegoDocker(ctx context.Context, cfg ExternalACMEConfig, domain, email string) error {
	if _, err := exec.LookPath("docker"); err != nil {
		return fmt.Errorf("docker not found (required for external acme): %w", err)
	}
	args := []string{
		"run", "--rm",
		"-v", fmt.Sprintf("%s:/lego", cfg.DataPath),
	}
	for k, v := range cfg.DNSEnv {
		if k == "" {
			continue
		}
		args = append(args, "-e", fmt.Sprintf("%s=%s", k, v))
	}
	args = append(args, cfg.DockerImage,
		"--path", "/lego",
		"--accept-tos",
		"--email", email,
		"--dns", cfg.DNSProvider,
		"-d", domain,
		"--key-type", cfg.KeyType,
	)
	if cfg.CADirURL != "" {
		args = append(args, "--server", cfg.CADirURL)
	} else if cfg.Staging {
		args = append(args, "--server", "https://acme-staging-v02.api.letsencrypt.org/directory")
	}
	args = append(args, "run")

	cmd := exec.CommandContext(ctx, "docker", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("lego docker run failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func (a *ACMEManager) runLegoBinary(ctx context.Context, cfg ExternalACMEConfig, domain, email string) error {
	if _, err := exec.LookPath("lego"); err != nil {
		return fmt.Errorf("lego binary not found (set use_docker=true or install lego): %w", err)
	}
	args := []string{
		"--path", cfg.DataPath,
		"--accept-tos",
		"--email", email,
		"--dns", cfg.DNSProvider,
		"-d", domain,
		"--key-type", cfg.KeyType,
	}
	if cfg.CADirURL != "" {
		args = append(args, "--server", cfg.CADirURL)
	} else if cfg.Staging {
		args = append(args, "--server", "https://acme-staging-v02.api.letsencrypt.org/directory")
	}
	args = append(args, "run")

	cmd := exec.CommandContext(ctx, "lego", args...)
	// Apply DNS env variables for the provider.
	if len(cfg.DNSEnv) > 0 {
		cmd.Env = append(os.Environ(), envMapToList(cfg.DNSEnv)...)
	}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("lego run failed: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func envMapToList(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		if k == "" {
			continue
		}
		out = append(out, fmt.Sprintf("%s=%s", k, v))
	}
	return out
}

func copyFile(src, dst string, mode os.FileMode) error {
	b, err := os.ReadFile(src)
	if err != nil {
		return err
	}
	if err := os.WriteFile(dst, b, mode); err != nil {
		return err
	}
	return nil
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
		_ = resp.Body.Close()
		if resp.StatusCode == http.StatusOK && bytes.Contains(body, []byte(domain)) {
			return nil
		}
	}
	return fmt.Errorf("acme issuance not confirmed for %s (timed out)", domain)
}
