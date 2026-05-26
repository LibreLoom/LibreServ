package network

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
)

type TunnelProviderType string

const (
	TunnelProviderCloudflare TunnelProviderType = "cloudflare"
)

type TunnelStatus struct {
	Available bool               `json:"available"`
	Enabled   bool               `json:"enabled"`
	Provider  TunnelProviderType `json:"provider,omitempty"`
	URL       string             `json:"url,omitempty"`
	Error     string             `json:"error,omitempty"`
}

type TunnelConfig struct {
	Provider TunnelProviderType `yaml:"provider" json:"provider"`
	Token    string             `yaml:"token" json:"-"`
	Enabled  bool               `yaml:"enabled" json:"enabled"`
}

type TunnelService struct {
	mu      sync.RWMutex
	config  TunnelConfig
	cmd     *exec.Cmd
	running bool
	logger  *slog.Logger
	binDir  string
}

func NewTunnelService(config TunnelConfig, binDir string) *TunnelService {
	return &TunnelService{
		config: config,
		logger: slog.Default().With("component", "tunnel"),
		binDir: binDir,
	}
}

func (t *TunnelService) Start(ctx context.Context) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	if t.running {
		return nil
	}

	if !t.config.Enabled {
		return nil
	}

	switch t.config.Provider {
	case TunnelProviderCloudflare:
		return t.startCloudflare()
	default:
		return fmt.Errorf("unsupported tunnel provider: %s", t.config.Provider)
	}
}

func (t *TunnelService) Stop() error {
	t.mu.Lock()
	defer t.mu.Unlock()

	if !t.running {
		return nil
	}

	if t.cmd != nil && t.cmd.Process != nil {
		if err := t.cmd.Process.Signal(os.Interrupt); err != nil {
			t.cmd.Process.Kill()
		}
		t.cmd.Wait()
	}

	t.running = false
	t.cmd = nil
	t.logger.Info("Tunnel stopped")
	return nil
}

func (t *TunnelService) Enable(provider TunnelProviderType, token string) error {
	t.mu.Lock()
	defer t.mu.Unlock()

	t.config.Provider = provider
	t.config.Token = token
	t.config.Enabled = true

	t.logger.Info("Tunnel enabled", "provider", provider)

	return nil
}

func (t *TunnelService) Disable() error {
	t.mu.Lock()
	t.config.Enabled = false
	t.mu.Unlock()

	return t.Stop()
}

func (t *TunnelService) GetStatus() TunnelStatus {
	t.mu.RLock()
	defer t.mu.RUnlock()

	status := TunnelStatus{
		Available: true,
		Enabled:   t.config.Enabled,
		Provider:  t.config.Provider,
	}

	if t.running {
		status.URL = t.getTunnelURL()
	}

	return status
}

func (t *TunnelService) IsCloudflaredInstalled() bool {
	path := t.cloudflaredPath()
	_, err := os.Stat(path)
	return err == nil
}

func (t *TunnelService) InstallCloudflared(ctx context.Context) error {
	if t.IsCloudflaredInstalled() {
		return nil
	}

	if err := os.MkdirAll(t.binDir, 0755); err != nil {
		return fmt.Errorf("create bin dir: %w", err)
	}

	t.logger.Info("Downloading cloudflared...")

	url := "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64"
	if _, err := exec.LookPath("curl"); err == nil {
		cmd := exec.CommandContext(ctx, "curl", "-L", "-o", t.cloudflaredPath(), url)
		if output, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("download cloudflared: %w (%s)", err, string(output))
		}
	} else if _, err := exec.LookPath("wget"); err == nil {
		cmd := exec.CommandContext(ctx, "wget", "-O", t.cloudflaredPath(), url)
		if output, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("download cloudflared: %w (%s)", err, string(output))
		}
	} else {
		return fmt.Errorf("neither curl nor wget available to download cloudflared")
	}

	if err := os.Chmod(t.cloudflaredPath(), 0755); err != nil {
		return fmt.Errorf("chmod cloudflared: %w", err)
	}

	t.logger.Info("cloudflared installed successfully")
	return nil
}

func (t *TunnelService) startCloudflare() error {
	if !t.IsCloudflaredInstalled() {
		if err := t.InstallCloudflared(context.Background()); err != nil {
			return fmt.Errorf("install cloudflared: %w", err)
		}
	}

	if t.config.Token == "" {
		return fmt.Errorf("cloudflare tunnel token is required")
	}

	cmd := exec.Command(t.cloudflaredPath(), "tunnel", "--no-autoupdate", "run", "--token", t.config.Token)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start cloudflared: %w", err)
	}

	t.cmd = cmd
	t.running = true

	go func() {
		err := cmd.Wait()
		t.mu.Lock()
		t.running = false
		t.cmd = nil
		t.mu.Unlock()

		if err != nil {
			t.logger.Warn("cloudflared exited", "error", err)
		}
	}()

	t.logger.Info("Cloudflare tunnel started")
	return nil
}

func (t *TunnelService) cloudflaredPath() string {
	return filepath.Join(t.binDir, "cloudflared")
}

func (t *TunnelService) getTunnelURL() string {
	return ""
}

func (t *TunnelService) Config() TunnelConfig {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.config
}

func (t *TunnelService) SetConfig(cfg TunnelConfig) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.config = cfg
}
