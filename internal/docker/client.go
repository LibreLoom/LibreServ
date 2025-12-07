package docker

import (
	"context"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/docker/docker/client"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

type Client struct {
	cli *client.Client
	ctx context.Context
}

// NewClient creates a new Docker client based on configuration
// Implements Recommendation #1: Multi-Method Docker Connection
func NewClient(cfg config.DockerConfig) (*Client, error) {
	switch cfg.Method {
	case "auto":
		return autoDetectConnection()
	case "socket":
		return connectViaSocket(cfg.SocketPath)
	case "tcp":
		return connectViaTCP(cfg.TCP)
	case "ssh":
		return connectViaSSH(cfg.SSH)
	default:
		return nil, fmt.Errorf("unknown docker connection method: %s", cfg.Method)
	}
}

func autoDetectConnection() (*Client, error) {
	// 1. Try DOCKER_HOST env var
	if host := os.Getenv("DOCKER_HOST"); host != "" {
		cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
		if err == nil {
			return &Client{cli: cli, ctx: context.Background()}, nil
		}
	}

	// 2. Try common socket paths
	socketPaths := []string{
		"/var/run/docker.sock",                    // Linux standard
		fmt.Sprintf("/Users/%s/.docker/run/docker.sock", os.Getenv("USER")), // Mac standard
		"//./pipe/docker_engine",                  // Windows standard
	}

	for _, path := range socketPaths {
		if _, err := os.Stat(path); err == nil {
			if c, err := connectViaSocket(path); err == nil {
				return c, nil
			}
		}
	}

	return nil, fmt.Errorf("docker daemon not found (tried env and common sockets)")
}

func connectViaSocket(socketPath string) (*Client, error) {
	if !strings.HasPrefix(socketPath, "unix://") && !strings.HasPrefix(socketPath, "npipe://") {
		socketPath = "unix://" + socketPath
	}
	
	cli, err := client.NewClientWithOpts(
		client.WithHost(socketPath),
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to connect to socket: %w", err)
	}
	return &Client{cli: cli, ctx: context.Background()}, nil
}

func connectViaTCP(cfg config.TCPConfig) (*Client, error) {
	host := fmt.Sprintf("tcp://%s:%d", cfg.Host, cfg.Port)
	opts := []client.Opt{
		client.WithHost(host),
		client.WithAPIVersionNegotiation(),
	}

	if cfg.UseTLS {
		// Load certs (simplified for now, usually requires CACert, Cert, Key)
		// opts = append(opts, client.WithTLSClientConfig( ... ))
	}

	cli, err := client.NewClientWithOpts(opts...)
	if err != nil {
		return nil, fmt.Errorf("failed to connect via TCP: %w", err)
	}
	return &Client{cli: cli, ctx: context.Background()}, nil
}

func connectViaSSH(cfg config.SSHConfig) (*Client, error) {
	host := fmt.Sprintf("ssh://%s@%s", cfg.User, cfg.Host)
	// SSH auth usually handled by system ssh-agent or ~/.ssh/id_rsa if not explicit
	
	cli, err := client.NewClientWithOpts(
		client.WithHost(host),
		client.WithAPIVersionNegotiation(),
	)
	if err != nil {
		return nil, fmt.Errorf("failed to connect via SSH: %w", err)
	}
	return &Client{cli: cli, ctx: context.Background()}, nil
}

// HealthCheck verifies connection to the daemon
func (c *Client) HealthCheck() error {
	ctx, cancel := context.WithTimeout(c.ctx, 5*time.Second)
	defer cancel()

	_, err := c.cli.Ping(ctx)
	if err != nil {
		return fmt.Errorf("docker daemon not responding: %w", err)
	}
	return nil
}

func (c *Client) Close() error {
	return c.cli.Close()
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
