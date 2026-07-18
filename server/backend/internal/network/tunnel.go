package network

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sync"
)

// TunnelProviderType identifies the tunnel backend.
type TunnelProviderType string

const (
	TunnelProviderCloudflare TunnelProviderType = "cloudflare"
)

// TunnelStatus is the public status of the tunnel service.
type TunnelStatus struct {
	Available bool               `json:"available"`
	Enabled   bool               `json:"enabled"`
	Provider  TunnelProviderType `json:"provider,omitempty"`
	URL       string             `json:"url,omitempty"`
	Error     string             `json:"error,omitempty"`
}

// TunnelConfig holds the persisted tunnel configuration.
type TunnelConfig struct {
	Provider TunnelProviderType `yaml:"provider" json:"provider"`
	Token    string             `yaml:"token" json:"-"`
	Enabled  bool               `yaml:"enabled" json:"enabled"`
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

// TunnelService manages the tunnel lifecycle, delegating to a TunnelProvider.
type TunnelService struct {
	mu       sync.RWMutex
	config   TunnelConfig
	provider TunnelProvider
	logger   *slog.Logger
	binDir   string
}

// NewTunnelService creates a tunnel service with the given config.
// The provider is selected based on the config; defaults to Cloudflare.
func NewTunnelService(config TunnelConfig, binDir string) *TunnelService {
	ts := &TunnelService{
		config: config,
		logger: slog.Default().With("component", "tunnel"),
		binDir: binDir,
	}
	ts.provider = ts.newProvider(config)
	return ts
}

// newProvider creates the appropriate tunnel provider for the given config.
func (t *TunnelService) newProvider(config TunnelConfig) TunnelProvider {
	switch config.Provider {
	case TunnelProviderCloudflare:
		return newCloudflareProvider(config, t.binDir, t.logger)
	default:
		return nil
	}
}

// Start starts the tunnel if enabled.
func (t *TunnelService) Start(ctx context.Context) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.provider == nil {
		return fmt.Errorf("no tunnel provider configured")
	}

	if !t.config.Enabled {
		return nil
	}

	return t.provider.Start(ctx)
}

// Stop stops the tunnel.
func (t *TunnelService) Stop() error {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.provider == nil {
		return nil
	}

	return t.provider.Stop()
}

// Enable configures and enables the tunnel with the given provider and token.
func (t *TunnelService) Enable(provider TunnelProviderType, token string) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.config.Provider = provider
	t.config.Token = token
	t.config.Enabled = true

	// Stop the old provider if running.
	if t.provider != nil {
		_ = t.provider.Stop()
	}

	// Create the new provider with the updated config.
	t.provider = t.newProvider(t.config)

	t.logger.Info("Tunnel enabled", "provider", provider)
	return nil
}

// Disable disables and stops the tunnel.
func (t *TunnelService) Disable() error {
	t.mu.Lock()
	t.config.Enabled = false
	t.mu.Unlock()

	return t.Stop()
}

// GetStatus returns the current tunnel status.
func (t *TunnelService) GetStatus() TunnelStatus {
	t.mu.RLock()
	defer t.mu.RUnlock()

	if t.provider == nil {
		return TunnelStatus{
			Available: false,
			Enabled:   t.config.Enabled,
			Provider:  t.config.Provider,
			Error:     "no tunnel provider configured",
		}
	}

	status := t.provider.Status()
	status.Enabled = t.config.Enabled
	return status
}

// Config returns the current tunnel configuration.
func (t *TunnelService) Config() TunnelConfig {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.config
}

// SetConfig updates the tunnel configuration and recreates the provider.
func (t *TunnelService) SetConfig(cfg TunnelConfig) {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.provider != nil {
		_ = t.provider.Stop()
	}
	t.config = cfg
	t.provider = t.newProvider(cfg)
}

// ─── Cloudflare Tunnel Provider ─────────────────────────────────────────────

// cloudflareProvider implements TunnelProvider using cloudflared.
type cloudflareProvider struct {
	config  TunnelConfig
	binDir  string
	logger  *slog.Logger
	mu      sync.Mutex
	cmd     *exec.Cmd
	running bool
}

func newCloudflareProvider(config TunnelConfig, binDir string, logger *slog.Logger) *cloudflareProvider {
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
