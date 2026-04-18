package system

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

// UpdateState tracks pending update verification
type UpdateState struct {
	OldVersion string    `json:"old_version"`
	NewVersion string    `json:"new_version"`
	BackupPath string    `json:"backup_path"`
	UpdatedAt  time.Time `json:"updated_at"`
	Verified   bool      `json:"verified"`
}

var (
	updateStateFile        = "update_state.json"
	updateStateDir         = "/var/lib/libreserv"
	updateStateDirFallback = "" // Set to user-writable path if /var/lib/libreserv unavailable
	verificationTimeout    = 5 * time.Minute
	cleanupDelay           = 24 * time.Hour
)

func init() {
	// Try to use /var/lib/libreserv, fallback to temp dir if not writable
	if _, err := os.Stat(updateStateDir); os.IsNotExist(err) {
		if err := os.MkdirAll(updateStateDir, 0755); err != nil {
			// Can't create /var/lib/libreserv, use fallback
			if tmpDir, err := os.UserConfigDir(); err == nil {
				updateStateDirFallback = tmpDir
			} else {
				updateStateDirFallback = os.TempDir()
			}
		}
	}
}

func getStateDir() string {
	if updateStateDirFallback != "" {
		return updateStateDirFallback
	}
	return updateStateDir
}

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
	repoOwner      string
	repoName       string
	baseURL        string
	client         *http.Client
	cacheMu        sync.RWMutex
	cachedInfo     *UpdateInfo
	cacheTimestamp time.Time
	cacheDuration  time.Duration
}

// defaultCacheDuration is how long to cache update check results
const defaultCacheDuration = 1 * time.Hour

// NewUpdateChecker creates a new update checker for Gitea
func NewUpdateChecker(owner, name string) *UpdateChecker {
	return &UpdateChecker{
		repoOwner:     owner,
		repoName:      name,
		baseURL:       "https://gt.plainskill.net/api/v1",
		cacheDuration: defaultCacheDuration,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// SetCacheDuration configures how long to cache update check results
func (c *UpdateChecker) SetCacheDuration(duration time.Duration) {
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	c.cacheDuration = duration
}

// ClearCache clears the update check cache
func (c *UpdateChecker) ClearCache() {
	c.cacheMu.Lock()
	defer c.cacheMu.Unlock()
	c.cachedInfo = nil
	c.cacheTimestamp = time.Time{}
}

// CheckForUpdates checks the Gitea API for the latest release
// Results are cached for 1 hour to avoid excessive API calls
// If forceRefresh is true, bypasses the cache and fetches fresh data
func (c *UpdateChecker) CheckForUpdates(currentVersion string, forceRefresh ...bool) (*UpdateInfo, error) {
	shouldForce := len(forceRefresh) > 0 && forceRefresh[0]

	// Check cache first (skip if force refresh)
	if !shouldForce {
		c.cacheMu.RLock()
		if c.cachedInfo != nil && time.Since(c.cacheTimestamp) < c.cacheDuration {
			cached := c.cachedInfo
			c.cacheMu.RUnlock()
			return cached, nil
		}
		c.cacheMu.RUnlock()
	}

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

	info := &UpdateInfo{
		CurrentVersion:  currentVersion,
		LatestVersion:   latest.TagName,
		UpdateAvailable: latestTag != currentTag && currentTag != "dev",
		ReleaseNotes:    latest.Body,
		PublishedAt:     latest.PublishedAt,
		URL:             latest.HTMLURL,
	}

	// Update cache
	c.cacheMu.Lock()
	c.cachedInfo = info
	c.cacheTimestamp = time.Now()
	c.cacheMu.Unlock()

	return info, nil
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

	// 6. Save update state for post-restart verification
	state := &UpdateState{
		OldVersion: currentVersion,
		NewVersion: info.LatestVersion,
		BackupPath: oldPath,
		UpdatedAt:  time.Now(),
		Verified:   false,
	}
	if err := saveUpdateState(state); err != nil {
		slog.Warn("Failed to save update state, rollback won't be available", "error", err)
	}

	// 7. Signal for restart (systemd will handle the actual restart if configured)
	go func() {
		slog.Info("Update applied successfully, restarting in 1 second",
			"old_version", currentVersion,
			"new_version", info.LatestVersion,
		)
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

// saveUpdateState persists update state to disk
func saveUpdateState(state *UpdateState) error {
	dir := getStateDir()
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create state directory: %w", err)
	}
	path := filepath.Join(dir, updateStateFile)
	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("failed to marshal state: %w", err)
	}
	if err := os.WriteFile(path, data, 0644); err != nil {
		return fmt.Errorf("failed to write state file: %w", err)
	}
	return nil
}

// loadUpdateState loads update state from disk
func loadUpdateState() (*UpdateState, error) {
	dir := getStateDir()
	path := filepath.Join(dir, updateStateFile)
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	var state UpdateState
	if err := json.Unmarshal(data, &state); err != nil {
		return nil, fmt.Errorf("failed to unmarshal state: %w", err)
	}
	return &state, nil
}

// deleteUpdateState removes the state file after successful verification
func deleteUpdateState() error {
	dir := getStateDir()
	path := filepath.Join(dir, updateStateFile)
	return os.Remove(path)
}

// VerifyAndUpdate checks if we just updated and verifies health.
// Returns true if rollback was performed, false otherwise.
// Call this early in main() before starting the server.
func VerifyAndUpdate(serverURL string) (rolledBack bool, err error) {
	state, err := loadUpdateState()
	if err != nil {
		slog.Warn("Failed to load update state", "error", err)
		return false, nil
	}
	if state == nil || state.Verified {
		return false, nil
	}

	slog.Info("Post-update verification started",
		"old_version", state.OldVersion,
		"new_version", state.NewVersion,
	)

	// Check if we're still within the verification window
	if time.Since(state.UpdatedAt) > verificationTimeout {
		slog.Warn("Update verification timeout exceeded, marking as verified")
		state.Verified = true
		_ = saveUpdateState(state)
		_ = scheduleCleanup(state.BackupPath)
		return false, deleteUpdateState()
	}

	// Perform health check
	healthy := checkHealth(serverURL)
	if healthy {
		slog.Info("Post-update health check passed", "new_version", state.NewVersion)
		state.Verified = true
		_ = saveUpdateState(state)
		_ = scheduleCleanup(state.BackupPath)
		return false, deleteUpdateState()
	}

	// Health check failed - rollback
	slog.Error("Post-update health check failed, initiating rollback",
		"new_version", state.NewVersion,
		"old_version", state.OldVersion,
	)

	if err := rollback(state); err != nil {
		slog.Error("Rollback failed", "error", err)
		_ = deleteUpdateState()
		return false, nil
	}

	slog.Info("Rollback completed successfully", "restored_version", state.OldVersion)
	return true, nil
}

// checkHealth performs a simple health check against the API
func checkHealth(serverURL string) bool {
	client := &http.Client{Timeout: 10 * time.Second}

	// Normalize URL - ensure it has protocol
	if !strings.HasPrefix(serverURL, "http://") && !strings.HasPrefix(serverURL, "https://") {
		serverURL = "http://" + serverURL
	}
	url := fmt.Sprintf("%s/api/v1/health", serverURL)

	resp, err := client.Get(url)
	if err != nil {
		slog.Warn("Health check request failed", "error", err)
		return false
	}
	defer func() { _ = resp.Body.Close() }()

	return resp.StatusCode == http.StatusOK
}

// rollback restores the previous binary version
func rollback(state *UpdateState) error {
	execPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to find executable path: %w", err)
	}

	if _, err := os.Stat(state.BackupPath); os.IsNotExist(err) {
		return fmt.Errorf("backup binary not found at %s", state.BackupPath)
	}

	// Move current (broken) binary to .failed
	failedPath := execPath + ".failed"
	if err := os.Rename(execPath, failedPath); err != nil {
		return fmt.Errorf("failed to move broken binary: %w", err)
	}

	// Restore backup
	if err := os.Rename(state.BackupPath, execPath); err != nil {
		// Try to restore failed binary
		_ = os.Rename(failedPath, execPath)
		return fmt.Errorf("failed to restore backup: %w", err)
	}

	// Make sure it's executable
	if err := os.Chmod(execPath, 0755); err != nil {
		return fmt.Errorf("failed to set permissions: %w", err)
	}

	// Exit to let systemd restart with old version
	go func() {
		slog.Info("Rollback complete, restarting with old version",
			"old_version", state.OldVersion,
		)
		time.Sleep(1 * time.Second)
		os.Exit(0)
	}()

	return nil
}

// scheduleCleanup schedules cleanup of old backup files
func scheduleCleanup(backupPath string) error {
	go func() {
		time.Sleep(cleanupDelay)
		if _, err := os.Stat(backupPath); err == nil {
			if err := os.Remove(backupPath); err != nil {
				slog.Warn("Failed to cleanup old backup", "path", backupPath, "error", err)
			} else {
				slog.Info("Cleaned up old backup", "path", backupPath)
			}
		}
	}()
	return nil
}
