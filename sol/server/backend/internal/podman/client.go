package podman

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/moby/moby/client"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

// Client wraps the container runtime API client and context.
type Client struct {
	cli    *client.Client
	ctx    context.Context
	binary string
}

// NewClient creates a new runtime client based on configuration
func NewClient(cfg config.RuntimeConfig) (*Client, error) {
	binary := cfg.Binary
	if binary == "" {
		binary = "podman"
	}

	var c *Client
	var err error
	switch cfg.Method {
	case "auto":
		c, err = autoDetectConnection()
	case "socket":
		c, err = connectViaSocket(cfg.SocketPath)
	case "tcp":
		c, err = connectViaTCP(cfg.TCP)
	default:
		return nil, fmt.Errorf("unknown runtime connection method: %s", cfg.Method)
	}
	if err != nil {
		return nil, err
	}
	c.binary = binary
	setDefaultBinary(binary)
	return c, nil
}

func autoDetectConnection() (*Client, error) {
	// 1. Try DOCKER_HOST env var
	if host := os.Getenv("DOCKER_HOST"); host != "" {
		cli, err := client.New(client.FromEnv)
		if err == nil {
			return &Client{cli: cli, ctx: context.Background()}, nil
		}
	}

	// 2. Try common socket paths (Podman only)
	socketPaths := []string{
		fmt.Sprintf("/run/user/%d/podman/podman.sock", os.Getuid()),
		"/run/podman/podman.sock",
	}

	for _, path := range socketPaths {
		if _, err := os.Stat(path); err == nil {
			if c, err := connectViaSocket(path); err == nil {
				return c, nil
			}
		}
	}

	// No socket found, but return a client anyway so compose operations can still work.
	return &Client{cli: nil, ctx: context.Background()}, nil
}

func connectViaSocket(socketPath string) (*Client, error) {
	if !strings.HasPrefix(socketPath, "unix://") && !strings.HasPrefix(socketPath, "npipe://") {
		socketPath = "unix://" + socketPath
	}

	cli, err := client.New(
		client.WithHost(socketPath),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to runtime socket: %w", err)
	}
	return &Client{cli: cli, ctx: context.Background()}, nil
}

func connectViaTCP(cfg config.TCPConfig) (*Client, error) {
	host := fmt.Sprintf("tcp://%s:%d", cfg.Host, cfg.Port)
	opts := []client.Opt{
		client.WithHost(host),
	}

	if cfg.UseTLS {
		// TLS requires certificate files to be configured
		if cfg.CertPath == "" {
			return nil, fmt.Errorf("runtime TLS enabled but cert_path not configured")
		}

		// Check if certificate files exist
		certFiles := []string{
			filepath.Join(cfg.CertPath, "ca.pem"),
			filepath.Join(cfg.CertPath, "cert.pem"),
			filepath.Join(cfg.CertPath, "key.pem"),
		}
		for _, f := range certFiles {
			if _, err := os.Stat(f); os.IsNotExist(err) {
				return nil, fmt.Errorf("runtime TLS certificate file not found: %s", f)
			}
		}

		// Configure TLS with client certificates
		opts = append(opts, client.WithTLSClientConfig(
			filepath.Join(cfg.CertPath, "ca.pem"),
			filepath.Join(cfg.CertPath, "cert.pem"),
			filepath.Join(cfg.CertPath, "key.pem"),
		))
	}

	cli, err := client.New(opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to connect via TCP: %w", err)
	}
	return &Client{cli: cli, ctx: context.Background()}, nil
}

// HealthCheck verifies that the container runtime is installed AND that its
// API daemon socket is reachable. This is stronger than checking the binary
// alone: `podman compose` delegates to the docker-compose plugin, which needs
// a persistent daemon socket (the rootless `podman.socket` systemd unit). A
// bare `podman --version` passes even when the socket is dead, which caused
// false "healthy" reports and opaque install failures ("Cannot connect to the
// Docker daemon").
//
// If the socket is absent, HealthCheck tries to start it (best-effort) before
// giving up, so users on a fresh boot don't hit a dead-end error.
func (c *Client) HealthCheck() error {
	if c == nil {
		return fmt.Errorf("container runtime not configured")
	}
	binary := c.Binary()
	if binary == "" {
		binary = "podman"
	}

	// 1. Binary present?
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := exec.CommandContext(ctx, binary, "--version").Output(); err != nil {
		return fmt.Errorf("container runtime not responding: %w", err)
	}

	// 2. Daemon socket reachable? `podman ps` exercises the API (it either
	//    talks to the running socket or forks a transient service, but if the
	//    socket path is configured and missing it surfaces the connection
	//    failure). We use --format to keep output minimal.
	if err := daemonReachable(binary); err != nil {
		// Best-effort: try to start the rootless Podman socket, then recheck.
		if started := EnsureSocketRunning(); started {
			if err2 := daemonReachable(binary); err2 != nil {
				return fmt.Errorf("container runtime daemon is not running: %w", err2)
			}
			return nil
		}
		return fmt.Errorf("container runtime daemon is not running: %w", err)
	}
	return nil
}

// daemonReachable runs a lightweight `podman ps` to confirm the API daemon
// (socket) is accepting connections. Distinguished from the binary check
// because `podman --version` never touches the daemon.
func daemonReachable(binary string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := exec.CommandContext(ctx, binary, "ps", "--format", "{{.ID}}").Run(); err != nil {
		return fmt.Errorf("daemon not reachable: %w", err)
	}
	return nil
}

// EnsureSocketRunning starts the rootless Podman API socket via systemd if it
// is not already accepting connections. Unlike a mere file-existence check
// (which passes on a stale socket left behind after the unit stops), this
// probes the socket with a real connection attempt — a stale socket file
// exists but refuses connections, so we must detect that and restart.
//
// LibreServ's goal is that users never need a terminal. The Podman rootless
// socket is a systemd user unit that is NOT enabled by default on most distros,
// so on a fresh boot `podman compose` fails with "Cannot connect to the Docker
// daemon". Auto-starting it removes that footgun.
//
// Returns true if the socket is accepting connections after the attempt.
func EnsureSocketRunning() bool {
	sp := rootlessSocketPath()
	if sp == "" {
		return false
	}
	if socketAlive(sp) {
		return true // already accepting connections
	}
	// Remove a stale socket file so systemd can re-create it cleanly.
	_ = os.Remove(sp)
	// Best-effort start; ignore errors (may not be systemd, may be rootful, etc.)
	_ = exec.Command("systemctl", "--user", "start", "podman.socket").Run()
	return socketAlive(sp)
}

// socketAlive returns true if the unix socket at path sp exists AND is
// currently accepting connections. A bare os.Stat is not enough: a stale
// socket file left behind after the systemd unit stops will pass Stat but
// refuse connections.
func socketAlive(sp string) bool {
	conn, err := net.DialTimeout("unix", sp, 2*time.Second)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

// rootlessSocketPath returns the expected Podman rootless socket path for the
// current user ($XDG_RUNTIME_DIR/podman/podman.sock), or "" if XDG_RUNTIME_DIR
// is unset (e.g. non-Linux or unusual environment).
func rootlessSocketPath() string {
	run := os.Getenv("XDG_RUNTIME_DIR")
	if run == "" {
		return ""
	}
	return filepath.Join(run, "podman", "podman.sock")
}

// Binary returns the configured runtime command binary (e.g. "podman").
func (c *Client) Binary() string {
	if c == nil || c.binary == "" {
		return "podman"
	}
	return c.binary
}

// Close releases the underlying runtime client.
func (c *Client) Close() error {
	if c.cli != nil {
		return c.cli.Close()
	}
	return nil
}

// Compose operations - delegate to ComposeManager

// ComposeUp starts containers defined in a compose file
func (c *Client) ComposeUp(ctx context.Context, composePath string) error {
	cm := NewComposeManager(c)
	return cm.Up(ctx, composePath)
}

// ComposeDown stops and removes containers defined in a compose file
func (c *Client) ComposeDown(ctx context.Context, composePath string) error {
	cm := NewComposeManager(c)
	return cm.Down(ctx, composePath)
}

// ComposePull pulls images defined in a compose file
func (c *Client) ComposePull(ctx context.Context, composePath string) error {
	cm := NewComposeManager(c)
	return cm.Pull(ctx, composePath)
}

// ComposeStop stops containers without removing them
func (c *Client) ComposeStop(ctx context.Context, composePath string) error {
	cm := NewComposeManager(c)
	return cm.Stop(ctx, composePath)
}
