package network

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

// FRPProviderType identifies the FRP tunnel backend.
const (
	TunnelProviderFRP TunnelProviderType = "frp"

	// frpRelease pins on-demand frpc installs (avoid mutable latest tags).
	frpRelease = "v0.61.0"
	// Reject tiny/truncated downloads before installing into binDir.
	minFrpcBytes = 1024
)

// FRPConfig holds the persisted settings for an FRP relay.
type FRPConfig struct {
	TunnelProviderConfig `yaml:",inline"`
	// Server is the frps address (host:port) of the relay.
	Server string `yaml:"server" json:"server"`
	// TLSEnabled forces TLS transport to frps (channel encryption + auth).
	// Per-device cert pinning is a TODO: provision a per-device CA and set
	// transport.tls.trustedCaFile (frp has no cert-fingerprint option).
	TLSEnabled bool `yaml:"tls_enabled,omitempty" json:"tls_enabled,omitempty"`
	// Proxies lists the port forwards to establish (name, localPort, remotePort).
	Proxies []FRPProxy `yaml:"proxies,omitempty" json:"proxies,omitempty"`
}

// FRPProxy is one port forward through the relay.
type FRPProxy struct {
	Name       string `yaml:"name" json:"name"`
	LocalPort  int    `yaml:"local_port" json:"local_port"`
	RemotePort int    `yaml:"remote_port" json:"remote_port"`
	Type       string `yaml:"type" json:"type"` // tcp | udp
}

// frpProvider implements TunnelProvider using frpc.
type frpProvider struct {
	config FRPConfig
	binDir string
	logger *slog.Logger
	mu     sync.Mutex
	cmd    *exec.Cmd
	pid    int
	// stopSupervise closes to tell the supervisor goroutine to exit. Guards
	// against two goroutines calling cmd.Wait() on the same process.
	stopSupervise chan struct{}
}

func newFRPProvider(config FRPConfig, binDir string, logger *slog.Logger) *frpProvider {
	return &frpProvider{
		config:        config,
		binDir:        binDir,
		logger:        logger,
		stopSupervise: make(chan struct{}),
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

	// Supervision (register #7): frpc exits if the relay is unreachable or
	// dies. Restart it on a short backoff so the tunnel self-heals without
	// waiting for the next Start() call at boot.
	f.stopSupervise = make(chan struct{})
	go f.supervise(ctx, cfgPath)
	return nil
}

// supervise restarts frpc after unexpected exits until the provider is
// explicitly stopped. Starts with a 2s backoff, doubling to a 30s cap.
func (f *frpProvider) supervise(ctx context.Context, cfgPath string) {
	backoff := 2 * time.Second
	const maxBackoff = 30 * time.Second

	for {
		select {
		case <-f.stopSupervise:
			return
		default:
		}

		f.mu.Lock()
		running := f.pid != 0
		cmd := f.cmd
		f.mu.Unlock()
		if !running || cmd == nil || cmd.Process == nil {
			return
		}
		if err := cmd.Wait(); err != nil {
			f.logger.Warn("frpc exited; will restart", "error", err)
		} else {
			f.logger.Warn("frpc exited cleanly; will restart")
		}

		select {
		case <-f.stopSupervise:
			return
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < maxBackoff {
			backoff *= 2
		}

		f.mu.Lock()
		// Stopped() may have killed the process between Wait and now.
		if f.pid == 0 {
			f.mu.Unlock()
			return
		}
		cmd = exec.CommandContext(ctx, f.frpcPath(), "-c", cfgPath)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Start(); err != nil {
			f.logger.Warn("frpc restart failed", "error", err)
			f.mu.Unlock()
			continue
		}
		f.cmd = cmd
		f.pid = cmd.Process.Pid
		f.logger.Info("FRP tunnel restarted", "pid", f.pid)
		f.mu.Unlock()
	}
}

// Stop terminates frpc.
func (f *frpProvider) Stop() error {
	f.mu.Lock()
	defer f.mu.Unlock()

	if f.pid == 0 {
		return nil
	}
	// Tell the supervisor to exit BEFORE Wait() so only one goroutine calls
	// cmd.Wait() on the process.
	select {
	case <-f.stopSupervise:
	default:
		close(f.stopSupervise)
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

	// frp publishes linux_amd64 and linux_arm64 tarballs. Fail on anything
	// else rather than silently fetching the wrong binary.
	var arch string
	switch runtime.GOARCH {
	case "amd64", "arm64":
		arch = runtime.GOARCH
	default:
		return fmt.Errorf("unsupported architecture for frpc download: %s", runtime.GOARCH)
	}
	downloadURL := fmt.Sprintf(
		"https://github.com/fatedier/frp/releases/download/%s/frp_%s_linux_%s.tar.gz",
		frpRelease, strings.TrimPrefix(frpRelease, "v"), arch,
	)
	f.logger.Info("Downloading frpc...", "url", downloadURL, "release", frpRelease)

	// Download + extract in a temp dir, then install frpc atomically.
	tmp, err := os.MkdirTemp("", "frp-download-*")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)

	archive := filepath.Join(tmp, "frp.tar.gz")
	var downloaded bool
	if _, err := exec.LookPath("curl"); err == nil {
		// HTTPS only; follow redirects (GitHub release assets) but refuse cleartext.
		cmd := exec.CommandContext(ctx, "curl", "-fsS", "--proto", "=https", "--tlsv1.2", "-L", "-o", archive, downloadURL)
		if output, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("download frpc: %w (%s)", err, string(output))
		}
		downloaded = true
	} else if _, err := exec.LookPath("wget"); err == nil {
		cmd := exec.CommandContext(ctx, "wget", "-q", "--https-only", "-O", archive, downloadURL)
		if output, err := cmd.CombinedOutput(); err != nil {
			return fmt.Errorf("download frpc: %w (%s)", err, string(output))
		}
		downloaded = true
	}
	if !downloaded {
		return fmt.Errorf("neither curl nor wget available to download frpc")
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

	info, err := os.Stat(frpcSrc)
	if err != nil {
		return fmt.Errorf("stat extracted frpc: %w", err)
	}
	if info.Size() < minFrpcBytes || !frpcDownloadIsELF(frpcSrc) {
		return fmt.Errorf("downloaded frpc failed integrity checks")
	}

	dest := f.frpcPath()
	staged := dest + ".tmp"
	_ = os.Remove(staged)
	data, err := os.ReadFile(frpcSrc)
	if err != nil {
		return err
	}
	if err := os.WriteFile(staged, data, 0o755); err != nil {
		_ = os.Remove(staged)
		return err
	}
	if err := os.Rename(staged, dest); err != nil {
		_ = os.Remove(staged)
		return fmt.Errorf("install frpc: %w", err)
	}
	f.logger.Info("frpc installed successfully", "release", frpRelease)
	return nil
}

// frpcDownloadIsELF reports whether path starts with Linux ELF magic.
func frpcDownloadIsELF(path string) bool {
	f, err := os.Open(path)
	if err != nil {
		return false
	}
	defer f.Close()
	var magic [4]byte
	if _, err := io.ReadFull(f, magic[:]); err != nil {
		return false
	}
	return magic == [4]byte{0x7f, 'E', 'L', 'F'}
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
	// frp splits host and port (serverAddr + serverPort), unlike a bare
	// "host:port" string.
	host, port := SplitHostPort(f.config.Server)
	fmt.Fprintf(&b, "serverAddr = %q\n", host)
	if port != "" {
		fmt.Fprintf(&b, "serverPort = %s\n", port)
	}
	if f.config.Token != "" {
		fmt.Fprintf(&b, "auth.method = \"token\"\n")
		fmt.Fprintf(&b, "auth.token = %q\n", f.config.Token)
	}
	if f.config.TLSEnabled {
		fmt.Fprintf(&b, "transport.tls.enable = true\n")
		fmt.Fprintf(&b, "transport.tls.serverName = %q\n", host)
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

// SplitHostPort splits "host:port" into separate frp fields; bare hosts are
// returned with an empty port (frp defaults serverPort to 7000). Exported for
// the mappings handler's config export.
func SplitHostPort(addr string) (host, port string) {
	host = addr
	if h, p, err := net.SplitHostPort(addr); err == nil {
		return h, p
	}
	return host, ""
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
