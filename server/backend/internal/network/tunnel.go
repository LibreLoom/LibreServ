package network

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"sync"
)

// TunnelProviderType identifies the tunnel backend.
type TunnelProviderType string

const (
	TunnelProviderCloudflare TunnelProviderType = "cloudflare"
)

// TunnelStatus is the public status of the tunnel service: a summary of all
// configured providers plus the per-provider list.
type TunnelStatus struct {
	Available bool               `json:"available"`
	Enabled   bool               `json:"enabled"`
	Provider  TunnelProviderType `json:"provider,omitempty"`
	URL       string             `json:"url,omitempty"`
	Error     string             `json:"error,omitempty"`
	Providers []TunnelStatus     `json:"providers,omitempty"`
}

// TunnelProviderConfig holds the persisted settings for one tunnel provider.
type TunnelProviderConfig struct {
	Token   string `yaml:"token" json:"-"`
	Enabled bool   `yaml:"enabled" json:"enabled"`
}

// TunnelConfig holds persisted tunnel configurations, keyed by provider.
type TunnelConfig struct {
	Providers map[TunnelProviderType]TunnelProviderConfig `yaml:"providers" json:"providers"`
}

// TunnelProvider is the interface for tunnel backends.
// Implement this to add a new tunnel provider (e.g. Ngrok, WireGuard).
// The provider manages its own process lifecycle and binary installation.
type TunnelProvider interface {
	// Start connects the tunnel using the configured token.
	Start(ctx context.Context) error
	// Stop disconnects the tunnel.
	Stop() error
	// IsInstalled returns true if the provider's binary is available.
	IsInstalled() bool
	// Install downloads and installs the provider's binary.
	Install(ctx context.Context) error
	// Status returns the provider-specific status.
	Status() TunnelStatus
}

// providerEntry binds a provider's persisted config to its live instance.
type providerEntry struct {
	config   TunnelProviderConfig
	provider TunnelProvider
}

// TunnelService manages tunnel provider lifecycles. Multiple providers can be
// configured and running simultaneously (e.g. cloudflared for web apps and an
// FRP relay for direct TCP/UDP ports) — enabling one never stops another.
type TunnelService struct {
	mu        sync.RWMutex
	providers map[TunnelProviderType]*providerEntry
	logger    *slog.Logger
	binDir    string

	// providerFactory is overridable for tests; defaults to newProvider.
	providerFactory func(TunnelProviderType, TunnelProviderConfig) TunnelProvider
}

// NewTunnelService creates a tunnel service seeded with the given providers.
func NewTunnelService(config TunnelConfig, binDir string) *TunnelService {
	ts := &TunnelService{
		providers: make(map[TunnelProviderType]*providerEntry),
		logger:    slog.Default().With("component", "tunnel"),
		binDir:    binDir,
	}
	for providerType, cfg := range config.Providers {
		ts.providers[providerType] = &providerEntry{
			config:   cfg,
			provider: ts.providerFor(providerType, cfg),
		}
	}
	return ts
}

// providerFor returns the provider for a type, honoring the test factory.
func (t *TunnelService) providerFor(providerType TunnelProviderType, cfg TunnelProviderConfig) TunnelProvider {
	if t.providerFactory != nil {
		return t.providerFactory(providerType, cfg)
	}
	return t.newProvider(providerType, cfg)
}

// newProvider creates the appropriate tunnel provider for the given type.
func (t *TunnelService) newProvider(providerType TunnelProviderType, cfg TunnelProviderConfig) TunnelProvider {
	switch providerType {
	case TunnelProviderCloudflare:
		return newCloudflareProvider(cfg, t.binDir, t.logger)
	default:
		return nil
	}
}

// Start starts all enabled tunnel providers.
func (t *TunnelService) Start(ctx context.Context) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	var errs []error
	for _, entry := range t.providers {
		if !entry.config.Enabled || entry.provider == nil {
			continue
		}
		if err := entry.provider.Start(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	if len(errs) > 0 {
		return errors.Join(errs...)
	}
	return nil
}

// Stop stops all tunnel providers.
func (t *TunnelService) Stop() error {
	t.mu.Lock()
	defer t.mu.Unlock()

	var errs []error
	for _, entry := range t.providers {
		if entry.provider != nil {
			if err := entry.provider.Stop(); err != nil {
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

// Enable configures and enables one provider without touching the others.
// The provider starts on the next Start() call (existing callers call Start
// after Enable).
func (t *TunnelService) Enable(provider TunnelProviderType, token string) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	entry, ok := t.providers[provider]
	if !ok {
		entry = &providerEntry{}
		t.providers[provider] = entry
	}
	entry.config.Token = token
	entry.config.Enabled = true
	if entry.provider == nil {
		entry.provider = t.providerFor(provider, entry.config)
	}

	t.logger.Info("Tunnel enabled", "provider", provider)
	return nil
}

// Disable disables and stops the given providers. With no arguments, all
// providers are disabled.
func (t *TunnelService) Disable(providers ...TunnelProviderType) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	var errs []error
	for providerType, entry := range t.providers {
		if len(providers) > 0 && !slices.Contains(providers, providerType) {
			continue
		}
		entry.config.Enabled = false
		if entry.provider != nil {
			if err := entry.provider.Stop(); err != nil {
				errs = append(errs, err)
			}
		}
		t.logger.Info("Tunnel disabled", "provider", providerType)
	}
	return errors.Join(errs...)
}

// GetStatus returns a summary plus per-provider status.
func (t *TunnelService) GetStatus() TunnelStatus {
	t.mu.RLock()
	defer t.mu.RUnlock()

	summary := TunnelStatus{}
	for providerType, entry := range t.providers {
		status := TunnelStatus{
			Provider: providerType,
			Enabled:  entry.config.Enabled,
		}
		if entry.provider != nil {
			ps := entry.provider.Status()
			status.Available = ps.Available
			status.URL = ps.URL
			status.Error = ps.Error
			if ps.Provider != "" {
				status.Provider = ps.Provider
			}
		}
		summary.Providers = append(summary.Providers, status)
		if status.Enabled {
			summary.Enabled = true
		}
		if status.Available && summary.Provider == "" {
			summary.Available = true
			summary.Provider = status.Provider
			summary.URL = status.URL
			summary.Error = status.Error
		}
	}
	if len(summary.Providers) == 0 {
		summary.Error = "no tunnel provider configured"
	}
	return summary
}

// Config returns the persisted per-provider configurations.
func (t *TunnelService) Config() TunnelConfig {
	t.mu.RLock()
	defer t.mu.RUnlock()

	cfg := TunnelConfig{Providers: make(map[TunnelProviderType]TunnelProviderConfig, len(t.providers))}
	for providerType, entry := range t.providers {
		cfg.Providers[providerType] = entry.config
	}
	return cfg
}

// SetConfig replaces all provider configurations and recreates their instances.
func (t *TunnelService) SetConfig(cfg TunnelConfig) {
	t.mu.Lock()
	defer t.mu.Unlock()

	for _, entry := range t.providers {
		if entry.provider != nil {
			_ = entry.provider.Stop()
		}
	}
	t.providers = make(map[TunnelProviderType]*providerEntry, len(cfg.Providers))
	for providerType, pc := range cfg.Providers {
		t.providers[providerType] = &providerEntry{
			config:   pc,
			provider: t.providerFor(providerType, pc),
		}
	}
}

// ─── Cloudflare Tunnel Provider ─────────────────────────────────────────────

// cloudflareProvider implements TunnelProvider using cloudflared.
type cloudflareProvider struct {
	config  TunnelProviderConfig
	binDir  string
	logger  *slog.Logger
	mu      sync.Mutex
	cmd     *exec.Cmd
	running bool
}

func newCloudflareProvider(config TunnelProviderConfig, binDir string, logger *slog.Logger) *cloudflareProvider {
	return &cloudflareProvider{
		config: config,
		binDir: binDir,
		logger: logger,
	}
}

func (c *cloudflareProvider) Start(ctx context.Context) error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.running {
		return nil
	}

	if !c.IsInstalled() {
		if err := c.Install(ctx); err != nil {
			return fmt.Errorf("install cloudflared: %w", err)
		}
	}

	if c.config.Token == "" {
		return fmt.Errorf("cloudflare tunnel token is required")
	}

	cmd := exec.CommandContext(ctx, c.cloudflaredPath(),
		"tunnel", "--no-autoupdate", "run", "--token", c.config.Token)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start cloudflared: %w", err)
	}

	c.cmd = cmd
	c.running = true

	go func() {
		err := cmd.Wait()
		c.mu.Lock()
		c.running = false
		c.cmd = nil
		c.mu.Unlock()

		if err != nil {
			c.logger.Warn("cloudflared exited", "error", err)
		}
	}()

	c.logger.Info("Cloudflare tunnel started")
	return nil
}

func (c *cloudflareProvider) Stop() error {
	c.mu.Lock()
	defer c.mu.Unlock()

	if !c.running {
		return nil
	}

	if c.cmd != nil && c.cmd.Process != nil {
		if err := c.cmd.Process.Signal(os.Interrupt); err != nil {
			c.cmd.Process.Kill()
		}
		c.cmd.Wait()
	}

	c.running = false
	c.cmd = nil
	c.logger.Info("Cloudflare tunnel stopped")
	return nil
}

func (c *cloudflareProvider) IsInstalled() bool {
	_, err := os.Stat(c.cloudflaredPath())
	return err == nil
}

func (c *cloudflareProvider) Install(ctx context.Context) error {
	if c.IsInstalled() {
		return nil
	}

	if err := os.MkdirAll(c.binDir, 0755); err != nil {
		return fmt.Errorf("create bin dir: %w", err)
	}

	arch := runtime.GOARCH
	if arch == "arm64" {
		arch = "arm64"
	} else {
		arch = "amd64"
	}

	downloadURL := fmt.Sprintf("https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-%s", arch)
	c.logger.Info("Downloading cloudflared...", "arch", arch)

	if _, err := exec.LookPath("curl"); err == nil {
		cmd := exec.CommandContext(ctx, "curl", "-L", "-o", c.cloudflaredPath(), downloadURL)
		if output, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("download cloudflared: %w (%s)", err, string(output))
		}
	} else if _, err := exec.LookPath("wget"); err == nil {
		cmd := exec.CommandContext(ctx, "wget", "-O", c.cloudflaredPath(), downloadURL)
		if output, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("download cloudflared: %w (%s)", err, string(output))
		}
	} else {
		return fmt.Errorf("neither curl nor wget available to download cloudflared")
	}

	if err := os.Chmod(c.cloudflaredPath(), 0755); err != nil {
		return fmt.Errorf("chmod cloudflared: %w", err)
	}

	c.logger.Info("cloudflared installed successfully")
	return nil
}

func (c *cloudflareProvider) Status() TunnelStatus {
	c.mu.Lock()
	defer c.mu.Unlock()

	return TunnelStatus{
		Available: true,
		Provider:  TunnelProviderCloudflare,
	}
}

func (c *cloudflareProvider) cloudflaredPath() string {
	return filepath.Join(c.binDir, "cloudflared")
}
