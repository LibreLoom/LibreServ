package system

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"runtime"
	"time"
)

// UpdateInfo represents information about a system update
type UpdateInfo struct {
	CurrentVersion  string    `json:"current_version"`
	LatestVersion   string    `json:"latest_version"`
	UpdateAvailable bool      `json:"update_available"`
	ReleaseNotes    string    `json:"release_notes,omitempty"`
	PublishedAt     time.Time `json:"published_at,omitempty"`
	URL             string    `json:"url,omitempty"`
}

// UpdateChecker handles checking for platform updates
type UpdateChecker struct {
	repoOwner string
	repoName  string
	baseURL   string
	client    *http.Client
}

// NewUpdateChecker creates a new update checker for Gitea
func NewUpdateChecker(owner, name string) *UpdateChecker {
	return &UpdateChecker{
		repoOwner: owner,
		repoName:  name,
		baseURL:   "https://gt.plainskill.net/api/v1",
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// CheckForUpdates checks the Gitea API for the latest release
func (c *UpdateChecker) CheckForUpdates(currentVersion string) (*UpdateInfo, error) {
	url := fmt.Sprintf("%s/repos/%s/%s/releases?limit=1", c.baseURL, c.repoOwner, c.repoName)

	resp, err := c.client.Get(url)
	if err != nil {
		return nil, fmt.Errorf("failed to check Gitea API: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("gitea API returned status: %d", resp.StatusCode)
	}

	var releases []giteaRelease
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return nil, fmt.Errorf("failed to decode Gitea response: %w", err)
	}

	if len(releases) == 0 {
		return &UpdateInfo{
			CurrentVersion:  currentVersion,
			LatestVersion:   currentVersion,
			UpdateAvailable: false,
		}, nil
	}

	latest := releases[0]
	// Remove 'v' prefix if present for comparison
	latestTag := latest.TagName
	if len(latestTag) > 0 && latestTag[0] == 'v' {
		latestTag = latestTag[1:]
	}

	currentTag := currentVersion
	if len(currentTag) > 0 && currentTag[0] == 'v' {
		currentTag = currentTag[1:]
	}

	return &UpdateInfo{
		CurrentVersion:  currentVersion,
		LatestVersion:   latest.TagName,
		UpdateAvailable: latestTag != currentTag && currentTag != "dev",
		ReleaseNotes:    latest.Body,
		PublishedAt:     latest.PublishedAt,
		URL:             latest.HTMLURL,
	}, nil
}

// ApplyUpdate downloads and replaces the current binary with the latest one
func (c *UpdateChecker) ApplyUpdate(ctx context.Context, currentVersion string) error {
	info, err := c.CheckForUpdates(currentVersion)
	if err != nil {
		return err
	}

	if !info.UpdateAvailable {
		return fmt.Errorf("no update available")
	}

	// 1. Determine download URL for current platform
	binaryName := fmt.Sprintf("libreserv-%s-%s", runtime.GOOS, runtime.GOARCH)
	downloadURL := fmt.Sprintf("https://gt.plainskill.net/libreloom/libreserv/releases/download/%s/%s", info.LatestVersion, binaryName)

	// 2. Download to temporary file
	tmpFile, err := os.CreateTemp("", "libreserv-update-*")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	defer os.Remove(tmpFile.Name())

	resp, err := c.client.Get(downloadURL)
	if err != nil {
		return fmt.Errorf("failed to download update: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to download update: Gitea returned %d", resp.StatusCode)
	}

	if _, err := io.Copy(tmpFile, resp.Body); err != nil {
		return fmt.Errorf("failed to save update: %w", err)
	}
	_ = tmpFile.Close()

	// 3. Make temporary file executable
	if err := os.Chmod(tmpFile.Name(), 0755); err != nil {
		return fmt.Errorf("failed to set permissions on update: %w", err)
	}

	// 4. Find current executable path
	execPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to find current executable: %w", err)
	}

	// 5. Replace current binary (atomic rename)
	// On Linux, you can rename over a running binary.
	// We'll move the old one to a .old file first for safety.
	oldPath := execPath + ".old"
	if err := os.Rename(execPath, oldPath); err != nil {
		return fmt.Errorf("failed to backup current binary: %w", err)
	}

	if err := os.Rename(tmpFile.Name(), execPath); err != nil {
		// Rollback backup
		_ = os.Rename(oldPath, execPath)
		return fmt.Errorf("failed to replace binary: %w", err)
	}

	// 6. Signal for restart (systemd will handle the actual restart if configured)
	// We exit with a special code or just exit and let systemd/docker restart us.
	go func() {
		time.Sleep(1 * time.Second)
		os.Exit(0)
	}()

	return nil
}

type giteaRelease struct {
	TagName     string    `json:"tag_name"`
	Target      string    `json:"target"`
	Name        string    `json:"name"`
	Body        string    `json:"body"`
	PublishedAt time.Time `json:"published_at"`
	HTMLURL     string    `json:"html_url"`
}
