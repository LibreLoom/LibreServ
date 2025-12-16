package docker

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type ComposeManager struct {
	client *Client
}

func NewComposeManager(client *Client) *ComposeManager {
	return &ComposeManager{client: client}
}

// getComposeArgs returns the compose file argument based on whether a full path or directory is provided
func (cm *ComposeManager) getComposeArgs(composePath string) (composeFile string, workDir string) {
	// Check if composePath is a file or directory
	if strings.HasSuffix(composePath, ".yml") || strings.HasSuffix(composePath, ".yaml") {
		// Full path to compose file
		composeFile = composePath
		workDir = filepath.Dir(composePath)
	} else {
		// Directory path - look for docker-compose.yml
		composeFile = filepath.Join(composePath, "docker-compose.yml")
		workDir = composePath
	}
	return
}

// Up runs `docker compose up -d`
// Implements Recommendation #7: Custom App Security (Sandboxing) via RunCustomAppSafely wrapper (future)
func (cm *ComposeManager) Up(ctx context.Context, composePath string) error {
	composeFile, workDir := cm.getComposeArgs(composePath)

	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-f", composeFile,
		"up", "-d", "--remove-orphans")

	cmd.Dir = workDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		// Implements Recommendation #1: Better Error Messages
		outStr := string(output)
		if strings.Contains(outStr, "Cannot connect to Docker daemon") {
			return fmt.Errorf("docker daemon not running or not accessible")
		}
		if strings.Contains(outStr, "permission denied") {
			return fmt.Errorf("permission denied accessing docker socket")
		}
		return fmt.Errorf("compose up failed: %s: %w", outStr, err)
	}
	return nil
}

func (cm *ComposeManager) Down(ctx context.Context, composePath string) error {
	composeFile, workDir := cm.getComposeArgs(composePath)

	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-f", composeFile,
		"down")

	cmd.Dir = workDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("compose down failed: %s: %w", string(output), err)
	}
	return nil
}

func (cm *ComposeManager) Pull(ctx context.Context, composePath string) error {
	composeFile, workDir := cm.getComposeArgs(composePath)

	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-f", composeFile,
		"pull")

	cmd.Dir = workDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("compose pull failed: %s: %w", string(output), err)
	}
	return nil
}

// Stop stops containers without removing them
func (cm *ComposeManager) Stop(ctx context.Context, composePath string) error {
	composeFile, workDir := cm.getComposeArgs(composePath)

	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-f", composeFile,
		"stop")

	cmd.Dir = workDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("compose stop failed: %s: %w", string(output), err)
	}
	return nil
}

// RunCustomAppSafely applies security hardening before running
// Implements Recommendation #7
func (cm *ComposeManager) RunCustomAppSafely(ctx context.Context, projectPath string) error {
	composePath := filepath.Join(projectPath, "docker-compose.yml")

	data, err := os.ReadFile(composePath)
	if err != nil {
		return err
	}

	var compose map[string]interface{}
	if err := yaml.Unmarshal(data, &compose); err != nil {
		return fmt.Errorf("invalid compose file: %w", err)
	}

	// Apply security defaults
	if services, ok := compose["services"].(map[string]interface{}); ok {
		for _, svc := range services {
			if s, ok := svc.(map[string]interface{}); ok {
				// Drop all capabilities
				s["cap_drop"] = []string{"ALL"}

				// Read-only filesystem
				s["read_only"] = true

				// No new privileges
				if secOpts, ok := s["security_opt"].([]interface{}); ok {
					s["security_opt"] = append(secOpts, "no-new-privileges:true")
				} else {
					s["security_opt"] = []string{"no-new-privileges:true"}
				}
			}
		}
	}

	// Write back hardened config
	hardenedData, err := yaml.Marshal(compose)
	if err != nil {
		return err
	}

	if err := os.WriteFile(composePath, hardenedData, 0644); err != nil {
		return err
	}

	return cm.Up(ctx, projectPath)
}
