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
	"strconv"
	"strings"
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
// The generic Providers map covers token-only providers (cloudflared); FRP
// additionally needs server/proxy config, kept in the typed FRP field.
type TunnelConfig struct {
	Providers map[TunnelProviderType]TunnelProviderConfig `yaml:"providers" json:"providers"`
	// FRP holds the full FRP relay config when an frp provider is configured.
	FRP *FRPConfig `yaml:"frp,omitempty" json:"frp,omitempty"`
}

// Capabilities describes what traffic a tunnel provider can carry. The
// decision engine routes per-app requirements against these — cloudflared is
// web-only (its TCP mode needs a client-side proxy; no UDP), while an FRP
// relay carries arbitrary TCP and UDP to vanilla clients.
type Capabilities struct {
	Web bool `json:"web"` // HTTPS reachability is sufficient
	TCP bool `json:"tcp"` // arbitrary TCP ports to vanilla clients
	UDP bool `json:"udp"` // UDP ports to vanilla clients
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
	// Capabilities declares what traffic this provider can carry.
	Capabilities() Capabilities
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
	// frpConfig holds the typed FRP relay config when one is configured.
	frpConfig *FRPConfig
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
	ts.frpConfig = config.FRP
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
	if providerType == TunnelProviderFRP && t.frpConfig != nil {
		return newFRPProvider(*t.frpConfig, t.binDir, t.logger)
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
	// A new token supersedes the old one: stop the running provider first so
	// cloudflared picks up the new token instead of keeping the stale tunnel
	// alive (Start() is a no-op while a process is already running).
	if entry.provider != nil && entry.config.Enabled && entry.config.Token != token {
		if err := entry.provider.Stop(); err != nil {
			return err
		}
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

	// Reap stale cloudflared processes from a previous backend instance that
	// was killed hard (SIGKILL leaves the child orphaned). Without this, the
	// orphan keeps the old tunnel alive and Start() appears to do nothing.
	reapStaleCloudflared(c.cloudflaredPath())

	// SECURITY FIX (audit #1): never pass the tunnel token via command-line args —
	// it would be visible to any local user or container via /proc/<pid>/cmdline
	// and `ps`. Instead inject it via environment (TUNNEL_TOKEN is read by
	// cloudflared) so the cmdline contains no secret.
	cmd := exec.CommandContext(ctx, c.cloudflaredPath(),
		"tunnel", "--no-autoupdate", "run")
	cmd.Env = append(os.Environ(),
		"TUNNEL_TOKEN="+c.config.Token,
		"CLOUDFLARED_TUNNEL_TOKEN="+c.config.Token,
	)
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

// Capabilities declares cloudflared's honest reach: web/HTTPS only. Its
// arbitrary-TCP mode requires the visitor to run cloudflared (a vanilla
// Minecraft client can't), and UDP is not supported at all — so TCP and UDP
// both return false, and the decision engine routes port-needing apps away.
func (c *cloudflareProvider) Capabilities() Capabilities {
	return Capabilities{Web: true}
}

func (c *cloudflareProvider) cloudflaredPath() string {
	return filepath.Join(c.binDir, "cloudflared")
}

// reapStaleCloudflared sends SIGINT to any cloudflared process still running
// from this binary path (i.e. a previous backend instance whose parent was
// killed hard, orphaning the child). It only matches processes started from
// the same binDir, so it never touches other tunnels (e.g. Connect's own).
func reapStaleCloudflared(binPath string) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return
	}
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		raw, err := os.ReadFile(filepath.Join("/proc", e.Name(), "cmdline"))
		if err != nil {
			continue
		}
		if !staleCloudflaredCmdline(string(raw), binPath) {
			continue
		}
		if proc, err := os.FindProcess(pid); err == nil {
			_ = proc.Signal(os.Interrupt)
		}
	}
}

// staleCloudflaredCmdline reports whether a /proc cmdline string (args
// NUL-separated) belongs to a cloudflared started from binPath.
func staleCloudflaredCmdline(cmdline string, binPath string) bool {
	marker := binPath + " tunnel --no-autoupdate run"
	return strings.Contains(strings.ReplaceAll(cmdline, "\x00", " "), marker)
}
