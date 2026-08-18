package podman

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

var defaultBinary = "podman"

func setDefaultBinary(b string) {
	if b != "" {
		defaultBinary = b
	}
}

func runtimeBinary() string {
	if defaultBinary != "" {
		return defaultBinary
	}
	return "podman"
}

// ComposeManager manages compose operations.
type ComposeManager struct {
	client *Client
}

// NewComposeManager creates a compose manager for a runtime client.
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

// extractBindMountPaths parses a compose file and returns all host-side bind mount paths.
func extractBindMountPaths(composePath string) ([]string, error) {
	data, err := os.ReadFile(composePath)
	if err != nil {
		return nil, fmt.Errorf("failed to read compose file: %w", err)
	}

	var compose map[string]interface{}
	if err := yaml.Unmarshal(data, &compose); err != nil {
		return nil, fmt.Errorf("failed to parse compose file: %w", err)
	}

	services, ok := compose["services"].(map[string]interface{})
	if !ok {
		return nil, nil
	}

	var paths []string
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

			parts := strings.SplitN(vol, ":", 3)
			if len(parts) < 2 {
				continue
			}

			hostPath := parts[0]
			if !strings.HasPrefix(hostPath, "/") {
				continue
			}

			paths = append(paths, hostPath)
		}
	}

	return paths, nil
}

// CreateVolumeDirs pre-creates host-side bind mount directories from a compose file.
// This prevents the runtime from creating them as root when setting up bind mounts.
func CreateVolumeDirs(composePath string) error {
	paths, err := extractBindMountPaths(composePath)
	if err != nil {
		return err
	}

	for _, hostPath := range paths {
		if err := os.MkdirAll(hostPath, 0750); err != nil {
			log.Printf("Warning: failed to pre-create volume directory %s: %v", hostPath, err)
			continue
		}

		_ = os.Chmod(hostPath, 0750)
	}

	return nil
}

// Up runs `docker compose up -d`.
//
// Before invoking compose, it ensures the Podman API daemon socket is running.
// The docker-compose plugin that `podman compose` delegates to needs a
// persistent daemon socket; on a fresh boot the rootless `podman.socket`
// systemd unit is often inactive, which produces the opaque "Cannot connect to
// the Docker daemon" error. Auto-starting the socket here prevents that.
func (cm *ComposeManager) Up(ctx context.Context, composePath string) error {
	// Pre-create volume directories before docker compose runs to prevent root-owned dirs
	if err := CreateVolumeDirs(composePath); err != nil {
		log.Printf("Warning: failed to pre-create volume directories: %v", err)
	}

	// Ensure the container daemon socket is up (best-effort; ignore failures —
	// the compose command itself will produce a clearer error if still down).
	EnsureSocketRunning()

	composeFile, workDir := cm.getComposeArgs(composePath)

	cmd := exec.CommandContext(ctx, cm.client.Binary(), "compose",
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

	cmd := exec.CommandContext(ctx, cm.client.Binary(), "compose",
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

	cmd := exec.CommandContext(ctx, cm.client.Binary(), "compose",
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
	cmd := exec.CommandContext(ctx, cm.client.Binary(), "compose",
		"-f", composeFile,
		"stop", "--timeout", "2") // 2 second timeout for graceful stop

	cmd.Dir = workDir
	output, err := cmd.CombinedOutput()
	if err != nil {
		// If graceful stop fails, try forceful kill with docker compose down --timeout 0
		killCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		defer cancel()

		killCmd := exec.CommandContext(killCtx, cm.client.Binary(), "compose",
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

// ChownBindMounts re-owns all bind mount host paths to the given uid/gid using a
// temporary Alpine container. This is necessary because container processes may write
// files with their internal UID (e.g. dnsmasq, polkitd), making them impossible for the
// host user to delete. The Alpine container runs as root and can chown any file.
func ChownBindMounts(ctx context.Context, composePath string, uid, gid int) error {
	paths, err := extractBindMountPaths(composePath)
	if err != nil {
		return fmt.Errorf("failed to extract bind mount paths: %w", err)
	}

	if len(paths) == 0 {
		return nil
	}

	owner := fmt.Sprintf("%d:%d", uid, gid)

	for _, hostPath := range paths {
		if _, err := os.Stat(hostPath); os.IsNotExist(err) {
			continue
		}

		cmd := exec.CommandContext(ctx, runtimeBinary(), "run", "--rm",
			"-v", hostPath+":/cleanup",
			"alpine:latest",
			"chown", "-R", owner, "/cleanup",
		)
		output, err := cmd.CombinedOutput()
		if err != nil {
			log.Printf("Warning: failed to chown bind mount %s: %v (%s)", hostPath, err, strings.TrimSpace(string(output)))
			continue
		}

		cmd2 := exec.CommandContext(ctx, runtimeBinary(), "run", "--rm",
			"-v", hostPath+":/cleanup",
			"alpine:latest",
			"chmod", "-R", "u+rw", "/cleanup",
		)
		output2, err2 := cmd2.CombinedOutput()
		if err2 != nil {
			log.Printf("Warning: failed to chmod bind mount %s: %v (%s)", hostPath, err2, strings.TrimSpace(string(output2)))
		}
	}

	return nil
}

// composeError translates raw compose-command output into actionable,
// plain-language errors. Per LibreServ's PLAIN LANGUAGE convention, every
// message explains what went wrong and what the user should do — never just a
// bare technical term.
func composeError(action string, output []byte, err error) error {
	outStr := string(output)
	if strings.Contains(outStr, "Cannot connect to the Docker daemon") || strings.Contains(outStr, "Cannot connect to Podman") {
		// The daemon socket was down when compose ran. Try to start it now so
		// the user's next attempt (or an immediate retry) succeeds.
		EnsureSocketRunning()
		return fmt.Errorf("the background service that runs apps (the container daemon) is not running. LibreServ tried to start it automatically — please try again in a few seconds. If the problem persists, restart your device")
	}
	if strings.Contains(outStr, "permission denied") {
		return fmt.Errorf("LibreServ does not have permission to talk to the container daemon. This usually means the daemon socket file has the wrong owner. Try restarting your device, or ask your system administrator to check the Podman or Docker permissions for your user account")
	}
	if strings.Contains(outStr, "unknown command \"compose\"") || strings.Contains(outStr, "looking up compose provider failed") {
		return fmt.Errorf("the app-running helper (compose) is not installed. LibreServ needs the 'docker-compose' or 'podman-compose' add-on to start apps. Install one of these and try again")
	}
	return fmt.Errorf("starting the app failed: %s", strings.TrimSpace(outStr))
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

	if err := os.WriteFile(composePath, pinnedData, 0600); err != nil {
		return fmt.Errorf("failed to write compose file: %w", err)
	}

	return nil
}
