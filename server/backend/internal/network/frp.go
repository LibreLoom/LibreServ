package network

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
)

// FRPProviderType identifies the FRP tunnel backend.
const (
	TunnelProviderFRP TunnelProviderType = "frp"
)

// FRPConfig holds the persisted settings for an FRP relay.
type FRPConfig struct {
	TunnelProviderConfig `yaml:",inline"`
	// Server is the frps address (host:port) of the relay.
	Server string `yaml:"server" json:"server"`
	// TLSCertFingerprint pins the frps TLS cert (per-device at provisioning).
	TLSCertFingerprint string `yaml:"tls_cert_fingerprint,omitempty" json:"tls_cert_fingerprint,omitempty"`
	// Proxies lists the port forwards to establish (name, localPort, remotePort).
	Proxies []FRPProxy `yaml:"proxies,omitempty" json:"proxies,omitempty"`
}

// FRPProxy is one port forward through the relay.
type FRPProxy struct {
	Name        string `yaml:"name" json:"name"`
	LocalPort   int    `yaml:"local_port" json:"local_port"`
	RemotePort  int    `yaml:"remote_port" json:"remote_port"`
	Type        string `yaml:"type" json:"type"` // tcp | udp
}

// frpProvider implements TunnelProvider using frpc.
type frpProvider struct {
	config FRPConfig
	binDir string
	logger *slog.Logger
	mu     sync.Mutex
	cmd    *exec.Cmd
	pid    int
}

func newFRPProvider(config FRPConfig, binDir string, logger *slog.Logger) *frpProvider {
	return &frpProvider{
		config: config,
		binDir: binDir,
		logger: logger,
	}
}

// Start launches frpc with a generated toml config. frpc exits if the relay
// is unreachable, so it is supervised: the process is restarted by the caller
// on Status() check or by the report loop.
func (f *frpProvider) Start(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.pid != 0 && f.processAlive() {
		return nil
	}

	if !f.IsInstalled() {
		if err := f.Install(ctx); err != nil {
			return fmt.Errorf("install frpc: %w", err)
		}
	}

	cfgPath, err := f.writeConfig()
	if err != nil {
		return err
	}

	cmd := exec.CommandContext(ctx, f.frpcPath(), "-c", cfgPath)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("start frpc: %w", err)
	}
	f.cmd = cmd
	f.pid = cmd.Process.Pid
	f.logger.Info("FRP tunnel started", "server", f.config.Server, "pid", f.pid)
	return nil
}

// Stop terminates frpc.
func (f *frpProvider) Stop() error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.pid == 0 {
		return nil
	}
	if f.cmd != nil && f.cmd.Process != nil {
		_ = f.cmd.Process.Signal(os.Interrupt)
		_ = f.cmd.Process.Kill()
	}
	f.pid = 0
	f.cmd = nil
	f.logger.Info("FRP tunnel stopped")
	return nil
}

// IsInstalled reports whether the frpc binary is available.
func (f *frpProvider) IsInstalled() bool {
	_, err := os.Stat(f.frpcPath())
	return err == nil
}

// Install downloads frpc from GitHub releases (mirrors cloudflared pattern).
func (f *frpProvider) Install(ctx context.Context) error {
	if f.IsInstalled() {
		return nil
	}
	if err := os.MkdirAll(f.binDir, 0o755); err != nil {
		return fmt.Errorf("create bin dir: %w", err)
	}

	version := "v0.61.0"
	arch := runtime.GOARCH
	if arch != "amd64" {
		arch = "arm64"
	}
	downloadURL := fmt.Sprintf("https://github.com/fatedier/frp/releases/download/%s/frp_%s_linux_%s.tar.gz", version, strings.TrimPrefix(version, "v"), arch)
	f.logger.Info("Downloading frpc...", "url", downloadURL)

	// Download + extract in a temp dir, then copy frpc into place.
	tmp, err := os.MkdirTemp("", "frp-download-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	if _, err := exec.LookPath("curl"); err != nil {
		return fmt.Errorf("curl not available to download frpc")
	}
	archive := filepath.Join(tmp, "frp.tar.gz")
	if output, err := exec.CommandContext(ctx, "curl", "-L", "-o", archive, downloadURL).CombinedOutput(); err != nil {
		return fmt.Errorf("download frpc: %w (%s)", err, string(output))
	}

	if output, err := exec.CommandContext(ctx, "tar", "-xzf", archive, "-C", tmp).CombinedOutput(); err != nil {
		return fmt.Errorf("extract frpc: %w (%s)", err, string(output))
	}

	// Locate frpc in the extracted tree (frp_vX.Y.Z_linux_arch/frpc).
	var frpcSrc string
	err = filepath.Walk(tmp, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}
		if !info.IsDir() && info.Name() == "frpc" {
			frpcSrc = path
		}
		return nil
	})
	if err != nil || frpcSrc == "" {
		return fmt.Errorf("frpc binary not found in archive")
	}

	data, err := os.ReadFile(frpcSrc)
	if err != nil {
		return err
	}
	if err := os.WriteFile(f.frpcPath(), data, 0o755); err != nil {
		return err
	}
	f.logger.Info("frpc installed successfully")
	return nil
}

// Status reports the provider status.
func (f *frpProvider) Status() TunnelStatus {
	f.mu.Lock()
	defer f.mu.Unlock()
	return TunnelStatus{
		Available: true,
		Provider:  TunnelProviderFRP,
		Enabled:   f.pid != 0,
	}
}

// Capabilities declares FRP's reach: arbitrary TCP and UDP to vanilla clients.
func (f *frpProvider) Capabilities() Capabilities {
	return Capabilities{Web: true, TCP: true, UDP: true}
}

// writeConfig generates an frpc toml config from the provider settings.
func (f *frpProvider) writeConfig() (string, error) {
	var b strings.Builder
	fmt.Fprintf(&b, "serverAddr = %q\n", f.config.Server)
	if f.config.Token != "" {
		fmt.Fprintf(&b, "auth.method = \"token\"\n")
		fmt.Fprintf(&b, "auth.token = %q\n", f.config.Token)
	}
	if f.config.TLSCertFingerprint != "" {
		fmt.Fprintf(&b, "tls.force = true\n")
		fmt.Fprintf(&b, "tls.serverName = %q\n", f.config.Server)
		fmt.Fprintf(&b, "tls.certFingerprint = %q\n", f.config.TLSCertFingerprint)
	}

	for _, p := range f.config.Proxies {
		proxType := p.Type
		if proxType == "" {
			proxType = "tcp"
		}
		fmt.Fprintf(&b, "\n[[proxies]]\n")
		fmt.Fprintf(&b, "name = %q\n", p.Name)
		fmt.Fprintf(&b, "type = %q\n", proxType)
		fmt.Fprintf(&b, "localPort = %d\n", p.LocalPort)
		fmt.Fprintf(&b, "remotePort = %d\n", p.RemotePort)
	}

	dir := filepath.Dir(f.frpcPath())
	cfgPath := filepath.Join(dir, "frpc.toml")
	if err := os.WriteFile(cfgPath, []byte(b.String()), 0o600); err != nil {
		return "", fmt.Errorf("write frpc config: %w", err)
	}
	return cfgPath, nil
}

func (f *frpProvider) frpcPath() string {
	return filepath.Join(f.binDir, "frpc")
}

// processAlive reports whether the current frpc process is still running.
func (f *frpProvider) processAlive() bool {
	if f.pid == 0 {
		return false
	}
	proc, err := os.FindProcess(f.pid)
	if err != nil {
		return false
	}
	// Signal 0 probes liveness without sending a real signal.
	return proc.Signal(syscall.Signal(0)) == nil
}