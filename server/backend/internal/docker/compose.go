package docker

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// ComposeManager manages docker compose operations.
type ComposeManager struct {
	client *Client
}

// NewComposeManager creates a compose manager for a Docker client.
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
	// Convert to absolute paths to avoid issues when cmd.Dir is set
	absFile, err := filepath.Abs(composeFile)
	if err == nil {
		composeFile = absFile
	}
	absDir, err := filepath.Abs(workDir)
	if err == nil {
		workDir = absDir
	}
	return
}

// CreateVolumeDirs pre-creates host-side bind mount directories from a compose file.
// This prevents docker compose from creating them as root when it sets up bind mounts.
func CreateVolumeDirs(composePath string) error {
	data, err := os.ReadFile(composePath)
	if err != nil {
		return fmt.Errorf("failed to read compose file: %w", err)
	}

	var compose map[string]interface{}
	if err := yaml.Unmarshal(data, &compose); err != nil {
		return fmt.Errorf("failed to parse compose file: %w", err)
	}

	services, ok := compose["services"].(map[string]interface{})
	if !ok {
		return nil
	}

	for _, svc := range services {
		s, ok := svc.(map[string]interface{})
		if !ok {
			continue
		}

		volumes, ok := s["volumes"].([]interface{})
		if !ok {
			continue
		}

		for _, v := range volumes {
			vol, ok := v.(string)
			if !ok {
				continue
			}

			parts := strings.SplitN(vol, ":", 2)
			if len(parts) != 2 {
				continue
			}

			hostPath := parts[0]
			if !strings.HasPrefix(hostPath, "/") {
				continue
			}

			if err := os.MkdirAll(hostPath, 0777); err != nil {
				log.Printf("Warning: failed to pre-create volume directory %s: %v", hostPath, err)
				continue
			}

			_ = os.Chmod(hostPath, 0777)
		}
	}

	return nil
}

// Up runs `docker compose up -d`
func (cm *ComposeManager) Up(ctx context.Context, composePath string) error {
	// Pre-create volume directories before docker compose runs to prevent root-owned dirs
	if err := CreateVolumeDirs(composePath); err != nil {
		log.Printf("Warning: failed to pre-create volume directories: %v", err)
	}

	composeFile, workDir := cm.getComposeArgs(composePath)

	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-f", composeFile,
		"up", "-d", "--remove-orphans")

	cmd.Dir = workDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return composeError("up", output, err)
	}
	return nil
}

// Down runs `docker compose down`.
func (cm *ComposeManager) Down(ctx context.Context, composePath string) error {
	composeFile, workDir := cm.getComposeArgs(composePath)

	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-f", composeFile,
		"down")

	cmd.Dir = workDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return composeError("down", output, err)
	}
	return nil
}

// Pull runs `docker compose pull`.
func (cm *ComposeManager) Pull(ctx context.Context, composePath string) error {
	composeFile, workDir := cm.getComposeArgs(composePath)

	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-f", composeFile,
		"pull")

	cmd.Dir = workDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		return composeError("pull", output, err)
	}
	return nil
}

// Stop stops containers without removing them
func (cm *ComposeManager) Stop(ctx context.Context, composePath string) error {
	composeFile, workDir := cm.getComposeArgs(composePath)

	// Try graceful stop first
	cmd := exec.CommandContext(ctx, "docker", "compose",
		"-f", composeFile,
		"stop", "--timeout", "2") // 2 second timeout for graceful stop

	cmd.Dir = workDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		// If graceful stop fails, try forceful kill with docker compose down --timeout 0
		killCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()

		killCmd := exec.CommandContext(killCtx, "docker", "compose",
			"-f", composeFile,
			"down", "--timeout", "0")

		killCmd.Dir = workDir
		killOutput, killErr := killCmd.CombinedOutput()
		if killErr != nil {
			// Both graceful and forceful stop failed
			return fmt.Errorf("graceful stop failed: %s; forceful kill also failed: %s: %w", output, killOutput, killErr)
		}
		// Forceful kill succeeded
		return nil
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

				// Run as host user to prevent root-owned files in volumes
				s["user"] = fmt.Sprintf("%d:%d", os.Getuid(), os.Getgid())
			}
		}
	}

	// Write back hardened config
	hardenedData, err := yaml.Marshal(compose)
	if err != nil {
		return err
	}

	if err := os.WriteFile(composePath, hardenedData, 0640); err != nil {
		return err
	}

	return cm.Up(ctx, projectPath)
}

func composeError(action string, output []byte, err error) error {
	outStr := string(output)
	if strings.Contains(outStr, "Cannot connect to Docker daemon") {
		return fmt.Errorf("docker daemon not running or not accessible")
	}
	if strings.Contains(outStr, "permission denied") {
		return fmt.Errorf("permission denied accessing docker socket")
	}
	if strings.Contains(outStr, "is not a docker command") || strings.Contains(outStr, "unknown command \"compose\"") {
		return fmt.Errorf("docker compose v2 is required (install Docker Compose plugin)")
	}
	return fmt.Errorf("compose %s failed: %s: %w", action, outStr, err)
}

func PinImageDigest(composePath string, imageRef string, digest string) error {
	data, err := os.ReadFile(composePath)
	if err != nil {
		return fmt.Errorf("failed to read compose file: %w", err)
	}

	var compose map[string]interface{}
	if err := yaml.Unmarshal(data, &compose); err != nil {
		return fmt.Errorf("failed to parse compose file: %w", err)
	}

	services, ok := compose["services"].(map[string]interface{})
	if !ok {
		return nil
	}

	pinnedImage := imageRef + "@sha256:" + digest
	for _, svc := range services {
		s, ok := svc.(map[string]interface{})
		if !ok {
			continue
		}
		if img, ok := s["image"].(string); ok && img == imageRef {
			s["image"] = pinnedImage
		}
	}

	pinnedData, err := yaml.Marshal(compose)
	if err != nil {
		return fmt.Errorf("failed to marshal compose: %w", err)
	}

	if err := os.WriteFile(composePath, pinnedData, 0644); err != nil {
		return fmt.Errorf("failed to write compose file: %w", err)
	}

	return nil
}

func ComposePinImageDigest(composePath string, appImage string, digest string) error {
	if appImage == "" || digest == "" {
		return nil
	}

	digestHex := digest
	if strings.HasPrefix(digest, "sha256:") {
		digestHex = digest[len("sha256:"):]
	}

	data, err := os.ReadFile(composePath)
	if err != nil {
		return fmt.Errorf("failed to read compose file: %w", err)
	}

	var compose map[string]interface{}
	if err := yaml.Unmarshal(data, &compose); err != nil {
		return fmt.Errorf("failed to parse compose file: %w", err)
	}

	services, ok := compose["services"].(map[string]interface{})
	if !ok {
		return nil
	}

	digestSuffix := "@sha256:" + digestHex
	for _, svc := range services {
		s, ok := svc.(map[string]interface{})
		if !ok {
			continue
		}
		img, ok := s["image"].(string)
		if !ok || img == "" {
			continue
		}
		if strings.Contains(img, "@sha256:") {
			continue
		}
		imgName := img
		if idx := strings.Index(img, ":"); idx > 0 {
			imgName = img[:idx]
		}
		if idx := strings.Index(img, "@"); idx > 0 {
			imgName = img[:idx]
		}
		if imgName != appImage && !strings.HasPrefix(imgName, appImage+"/") {
			continue
		}
		s["image"] = img + digestSuffix
	}

	pinnedData, err := yaml.Marshal(compose)
	if err != nil {
		return fmt.Errorf("failed to marshal compose: %w", err)
	}

	if err := os.WriteFile(composePath, pinnedData, 0644); err != nil {
		return fmt.Errorf("failed to write compose file: %w", err)
	}

	return nil
}
