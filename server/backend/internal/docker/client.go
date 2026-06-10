package docker

import (
	"context"
	"fmt"
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
	case "ssh":
		c, err = connectViaSSH(cfg.SSH)
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

func connectViaSSH(cfg config.SSHConfig) (*Client, error) {
	host := fmt.Sprintf("ssh://%s@%s", cfg.User, cfg.Host)
	// SSH auth usually handled by system ssh-agent or ~/.ssh/id_rsa if not explicit

	cli, err := client.New(
		client.WithHost(host),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to connect via SSH: %w", err)
	}
	return &Client{cli: cli, ctx: context.Background()}, nil
}

// HealthCheck verifies that the runtime binary is available on the system.
// Since container operations now use the Podman CLI, this checks that the
// configured binary (e.g. "podman") is in PATH rather than a socket.
func (c *Client) HealthCheck() error {
	if c == nil {
		return fmt.Errorf("container runtime not configured")
	}
	binary := c.Binary()
	if binary == "" {
		binary = "podman"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, binary, "--version")
	if _, err := cmd.Output(); err != nil {
		return fmt.Errorf("container runtime not responding: %w", err)
	}
	return nil
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
