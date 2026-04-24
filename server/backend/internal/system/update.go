package system

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
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

	"github.com/Masterminds/semver/v3"
	"golang.org/x/sys/unix"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/util"
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
	updateStateFile              = "update_state.json"
	updateStateDir               = "/var/lib/libreserv"
	updateStateDirFallback       = ""
	verificationTimeout          = 5 * time.Minute
	cleanupDelay                 = 24 * time.Hour
	fileOpTimeout                = 30 * time.Second
	minDiskSpace           int64 = 100 << 20 // 100 MB
)

// RestartSignal is used to signal that a restart is required
type RestartSignal struct{}

func (e RestartSignal) Error() string { return "restart required" }

func init() {
	if err := os.MkdirAll(updateStateDir, 0750); err != nil {
		if tmpDir, err := os.UserConfigDir(); err == nil {
			updateStateDirFallback = tmpDir
		} else {
			updateStateDirFallback = os.TempDir()
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
	Checksum        string    `json:"checksum,omitempty"`
}

// UpdateChecker handles checking for platform updates
type UpdateChecker struct {
	repoOwner      string
	repoName       string
	baseURL        string
	client         *http.Client
	cacheMu        sync.RWMutex
	cachedInfo     map[string]*UpdateInfo
	cacheTimestamp map[string]time.Time
	cacheDuration  time.Duration
	restartCh      chan<- RestartSignal
}

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
		cachedInfo:     make(map[string]*UpdateInfo),
		cacheTimestamp: make(map[string]time.Time),
	}
}

// SetRestartChannel sets the channel to signal restarts
func (c *UpdateChecker) SetRestartChannel(ch chan<- RestartSignal) {
	c.restartCh = ch
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
	c.cachedInfo = make(map[string]*UpdateInfo)
	c.cacheTimestamp = make(map[string]time.Time)
}

// CheckForUpdates checks the Gitea API for the latest release
func (c *UpdateChecker) CheckForUpdates(currentVersion string, forceRefresh ...bool) (*UpdateInfo, error) {
	shouldForce := len(forceRefresh) > 0 && forceRefresh[0]
	cacheKey := currentVersion

	// Check cache first (skip if force refresh)
	if !shouldForce {
		c.cacheMu.RLock()
		if info, ok := c.cachedInfo[cacheKey]; ok && time.Since(c.cacheTimestamp[cacheKey]) < c.cacheDuration {
			c.cacheMu.RUnlock()
			return info, nil
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
		info := &UpdateInfo{
			CurrentVersion:  currentVersion,
			LatestVersion:   currentVersion,
			UpdateAvailable: false,
		}
		c.cacheMu.Lock()
		c.cachedInfo[cacheKey] = info
		c.cacheTimestamp[cacheKey] = time.Now()
		c.cacheMu.Unlock()
		return info, nil
	}

	latest := releases[0]
	latestTag := strings.TrimPrefix(latest.TagName, "v")
	currentTag := strings.TrimPrefix(currentVersion, "v")

	// Use semver for proper version comparison
	var updateAvailable bool
	if currentTag == "dev" {
		updateAvailable = false
	} else {
		currentSemver, errCurr := semver.NewVersion(currentTag)
		latestSemver, errLat := semver.NewVersion(latestTag)
		if errCurr == nil && errLat == nil {
			updateAvailable = latestSemver.GreaterThan(currentSemver)
		} else {
			// Fallback to string comparison if semver parsing fails
			updateAvailable = latestTag != currentTag
		}
	}

	// Fetch checksum from SHA256SUMS.txt
	checksum := c.fetchChecksum(latest.TagName)

	info := &UpdateInfo{
		CurrentVersion:  currentVersion,
		LatestVersion:   latest.TagName,
		UpdateAvailable: updateAvailable,
		ReleaseNotes:    latest.Body,
		PublishedAt:     latest.PublishedAt,
		URL:             latest.HTMLURL,
		Checksum:        checksum,
	}

	// Update cache
	c.cacheMu.Lock()
	c.cachedInfo[cacheKey] = info
	c.cacheTimestamp[cacheKey] = time.Now()
	c.cacheMu.Unlock()

	return info, nil
}

// fetchChecksum retrieves the SHA256 checksum for a release
func (c *UpdateChecker) fetchChecksum(tagName string) string {
	checksumURL := fmt.Sprintf("https://gt.plainskill.net/libreloom/libreserv/releases/download/%s/SHA256SUMS.txt", tagName)
	resp, err := c.client.Get(checksumURL)
	if err != nil {
		slog.Warn("Failed to fetch checksum file", "error", err)
		return ""
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		slog.Warn("Checksum file not found", "status", resp.StatusCode)
		return ""
	}

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		slog.Warn("Failed to read checksum file", "error", err)
		return ""
	}

	// Parse SHA256SUMS.txt format: "checksum  filename"
	lines := strings.Split(string(body), "\n")
	binaryName := fmt.Sprintf("libreserv-%s-%s", runtime.GOOS, runtime.GOARCH)
	for _, line := range lines {
		parts := strings.Fields(line)
		if len(parts) >= 2 && strings.Contains(parts[1], binaryName) {
			return strings.TrimSpace(parts[0])
		}
	}

	return ""
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

	// 2. Check available disk space
	if err := checkDiskSpace(minDiskSpace); err != nil {
		return fmt.Errorf("insufficient disk space: %w", err)
	}

	// 3. Download to temporary file
	tmpFile, err := os.CreateTemp("", "libreserv-update-*")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	defer func() {
		_ = os.Remove(tmpPath)
	}()

	resp, err := c.client.Get(downloadURL)
	if err != nil {
		return fmt.Errorf("failed to download update: %w", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("failed to download update: Gitea returned %d", resp.StatusCode)
	}

	// Download with checksum verification
	hasher := sha256.New()
	teeReader := io.TeeReader(resp.Body, hasher)

	if _, err := io.Copy(tmpFile, teeReader); err != nil {
		return fmt.Errorf("failed to save update: %w", err)
	}
	_ = tmpFile.Close()

	// 4. Verify checksum if available
	if info.Checksum != "" {
		actualChecksum := hex.EncodeToString(hasher.Sum(nil))
		if actualChecksum != info.Checksum {
			return fmt.Errorf("checksum mismatch: expected %s, got %s", info.Checksum, actualChecksum)
		}
		slog.Info("Checksum verification passed", "checksum", actualChecksum)
	} else {
		slog.Warn("No checksum available for verification")
	}

	// 5. Make temporary file executable
	if err := os.Chmod(tmpPath, 0755); err != nil {
		return fmt.Errorf("failed to set permissions on update: %w", err)
	}

	// 6. Find current executable path
	execPath, err := os.Executable()
	if err != nil {
		return fmt.Errorf("failed to find current executable: %w", err)
	}

	// 7. Replace current binary with timeout
	oldPath := execPath + ".old"
	if err := timedRename(execPath, oldPath, fileOpTimeout); err != nil {
		return fmt.Errorf("failed to backup current binary: %w", err)
	}

	if err := timedRename(tmpPath, execPath, fileOpTimeout); err != nil {
		// Attempt rollback
		if rbErr := timedRename(oldPath, execPath, fileOpTimeout); rbErr != nil {
			slog.Error("Rollback failed after update failure", "error", rbErr)
		} else {
			slog.Info("Rollback successful")
		}
		return fmt.Errorf("failed to replace binary: %w", err)
	}

	// 8. Save update state for post-restart verification
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

	// 9. Signal for restart (use channel instead of os.Exit)
	if c.restartCh != nil {
		slog.Info("Update applied successfully, signaling restart",
			"old_version", currentVersion,
			"new_version", info.LatestVersion,
		)
		c.restartCh <- RestartSignal{}
	} else {
		// Fallback: exit directly (less graceful)
		go func() {
			slog.Info("Update applied successfully, restarting in 1 second",
				"old_version", currentVersion,
				"new_version", info.LatestVersion,
			)
			time.Sleep(1 * time.Second)
			os.Exit(0)
		}()
	}

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

// saveUpdateState persists update state to disk with secure permissions
func saveUpdateState(state *UpdateState) error {
	dir := getStateDir()
	if err := os.MkdirAll(dir, 0750); err != nil {
		return fmt.Errorf("failed to create state directory: %w", err)
	}
	path := filepath.Join(dir, updateStateFile)
	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("failed to marshal state: %w", err)
	}
	// Use 0600 for secure permissions (owner read/write only)
	if err := os.WriteFile(path, data, 0600); err != nil {
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
		// Delete state file even on rollback failure to avoid confusion
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

	// Try HTTPS first if serverURL doesn't specify protocol
	urls := []string{
		fmt.Sprintf("%s/api/v1/health", serverURL),
	}

	// If using HTTP, also try HTTPS
	if strings.HasPrefix(serverURL, "http://") {
		httpsURL := strings.Replace(serverURL, "http://", "https://", 1)
		urls = append(urls, fmt.Sprintf("%s/api/v1/health", httpsURL))
	}

	for _, url := range urls {
		resp, err := client.Get(url)
		if err == nil && resp.StatusCode == http.StatusOK {
			_ = resp.Body.Close()
			return true
		}
		if err == nil {
			_ = resp.Body.Close()
		}
	}

	slog.Warn("All health check URLs failed")
	return false
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
	if err := timedRename(execPath, failedPath, fileOpTimeout); err != nil {
		return fmt.Errorf("failed to move broken binary: %w", err)
	}

	// Restore backup
	if err := timedRename(state.BackupPath, execPath, fileOpTimeout); err != nil {
		// Try to restore failed binary
		if rbErr := timedRename(failedPath, execPath, fileOpTimeout); rbErr != nil {
			slog.Error("Failed to restore broken binary after rollback failure", "error", rbErr)
		}
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

// checkDiskSpace verifies that there's enough free disk space
func checkDiskSpace(requiredBytes int64) error {
	var stat unix.Statfs_t
	if err := unix.Statfs("/", &stat); err != nil {
		return fmt.Errorf("failed to check disk space: %w", err)
	}

	// Available space = free blocks * block size
	available := int64(util.SafeDiskBytes(int64(stat.Bavail), stat.Bsize))

	if available < requiredBytes {
		return fmt.Errorf("only %d bytes available, need %d bytes", available, requiredBytes)
	}

	return nil
}

// timedRename performs a rename operation with a timeout
func timedRename(oldPath, newPath string, timeout time.Duration) error {
	done := make(chan error, 1)
	go func() {
		done <- os.Rename(oldPath, newPath)
	}()

	select {
	case err := <-done:
		return err
	case <-time.After(timeout):
		return fmt.Errorf("rename operation timed out after %v", timeout)
	}
}
