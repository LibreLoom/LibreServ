package system

import (
	"context"
	"encoding/json"
	"errors"
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

	"golang.org/x/sys/unix"
	"gt.plainskill.net/LibreLoom/Sol/internal/config"
	"gt.plainskill.net/LibreLoom/Sol/internal/feed"
	"gt.plainskill.net/LibreLoom/Sol/internal/util"

	"aead.dev/minisign"
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
	updateStateDir               = "/var/lib/sol"
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
	Checksum        string    `json:"checksum,omitempty"`
}

const (
	feedUnit = "sol"
	feedPart = "sol"
	feedOS   = "linux"
	// maxFeedBytes caps the feed and signature downloads.
	maxFeedBytes = 1 << 20
)

// StateStore keeps small values across restarts (settings.Repository
// satisfies it).
type StateStore interface {
	Get(key string) (string, error)
	Set(key, value, typ string) error
}

// ValidChannel reports whether name is an update channel Sol knows.
func ValidChannel(name string) bool { return name == "stable" || name == "beta" }

// UpdateChecker handles checking for platform updates
type UpdateChecker struct {
	cfg            config.UpdatesConfig
	client         *http.Client
	downloadClient *http.Client
	cacheMu        sync.RWMutex
	cachedInfo     map[string]*UpdateInfo
	cacheTimestamp map[string]time.Time
	cacheDuration  time.Duration
	restartCh      chan<- RestartSignal
	pinnedKeys     []minisign.PublicKey
	store          StateStore
	arch           string // GOARCH of the running binary; tests override
	exePath        string // installed binary; tests override
	mu             sync.Mutex
}

const defaultCacheDuration = 1 * time.Hour

// NewUpdateChecker creates a new update checker for the signed feed.
func NewUpdateChecker(cfg config.UpdatesConfig) *UpdateChecker {
	if !ValidChannel(cfg.Channel) {
		cfg.Channel = "stable"
	}
	return &UpdateChecker{
		cfg:           cfg,
		cacheDuration: defaultCacheDuration,
		client: &http.Client{
			Timeout: 10 * time.Second,
		},
		// No overall timeout: the binary is large. ApplyUpdate bounds it with a context.
		downloadClient: &http.Client{},
		cachedInfo:     make(map[string]*UpdateInfo),
		cacheTimestamp: make(map[string]time.Time),
		arch:           runtime.GOARCH,
	}
}

// SetRestartChannel sets the channel to signal restarts
func (c *UpdateChecker) SetRestartChannel(ch chan<- RestartSignal) {
	c.restartCh = ch
}

// SetStateStore sets where the newest feed date seen per channel is kept.
func (c *UpdateChecker) SetStateStore(s StateStore) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.store = s
}

// Channel returns the update channel in use.
func (c *UpdateChecker) Channel() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.cfg.Channel
}

// SetChannel switches channel ("stable" or "beta") and drops cached results.
func (c *UpdateChecker) SetChannel(channel string) error {
	if !ValidChannel(channel) {
		return fmt.Errorf("invalid update channel %q", channel)
	}
	c.mu.Lock()
	c.cfg.Channel = channel
	c.mu.Unlock()
	c.ClearCache()
	return nil
}

// RequestRestart asks the running process to restart itself (graceful
// shutdown, then re-exec of the same binary). Used by the Troubleshooting
// page's "Restart now" button — the same path the update flow uses after
// applying an update. No-op if no restart channel is wired (e.g. tests).
func (c *UpdateChecker) RequestRestart() {
	if c.restartCh != nil {
		c.restartCh <- RestartSignal{}
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
	c.cachedInfo = make(map[string]*UpdateInfo)
	c.cacheTimestamp = make(map[string]time.Time)
}

func newestSeenKey(channel string) string {
	return "updates.newest_published." + feedUnit + "." + channel
}

func (c *UpdateChecker) getLimited(ctx context.Context, url string) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusNotFound {
		return nil, fmt.Errorf("%s: %w", url, ErrNoFeed)
	}
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s returned status %d", url, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxFeedBytes+1))
	if err != nil {
		return nil, err
	}
	if len(body) > maxFeedBytes {
		return nil, fmt.Errorf("%s is too large", url)
	}
	return body, nil
}

// ErrNoFeed means the update server has no feed for this channel yet.
var ErrNoFeed = errors.New("no update feed published for this channel")

// fetchFeed downloads, verifies and checks the feed for the running version.
// It records the feed's "published" date once the feed has passed every rule.
func (c *UpdateChecker) fetchFeed(ctx context.Context, currentVersion string) (*feed.Result, error) {
	c.mu.Lock()
	channel := c.cfg.Channel
	feedURL := strings.TrimRight(c.cfg.FeedURL, "/")
	store := c.store
	c.mu.Unlock()

	url := fmt.Sprintf("%s/%s.json", feedURL, channel)
	body, err := c.getLimited(ctx, url)
	if err != nil {
		return nil, fmt.Errorf("failed to fetch update feed: %w", err)
	}
	sig, err := c.getLimited(ctx, url+".minisig")
	if err != nil {
		return nil, fmt.Errorf("failed to fetch update feed signature: %w", err)
	}

	seen := ""
	if store != nil {
		if v, err := store.Get(newestSeenKey(channel)); err != nil {
			slog.Warn("could not read newest update date seen", "error", err)
		} else {
			seen = v
		}
	}

	res, err := feed.Check(c.pinned(), body, sig, feed.Request{
		Unit:                feedUnit,
		Channel:             channel,
		OS:                  feedOS,
		Arch:                c.arch,
		Part:                feedPart,
		InstalledVersion:    currentVersion,
		NewestPublishedSeen: seen,
	})
	if err != nil {
		return nil, err
	}
	if store != nil && res.Feed.Published > seen {
		if err := store.Set(newestSeenKey(channel), res.Feed.Published, "string"); err != nil {
			slog.Warn("could not store newest update date seen", "error", err)
		}
	}
	return res, nil
}

func noUpdate(currentVersion string) *UpdateInfo {
	return &UpdateInfo{CurrentVersion: currentVersion, LatestVersion: currentVersion}
}

// CheckForUpdates reads the signed feed and reports whether a newer Sol exists.
func (c *UpdateChecker) CheckForUpdates(currentVersion string, forceRefresh ...bool) (*UpdateInfo, error) {
	shouldForce := len(forceRefresh) > 0 && forceRefresh[0]
	cacheKey := c.Channel() + "|" + currentVersion

	// Check cache first (skip if force refresh)
	if !shouldForce {
		c.cacheMu.RLock()
		if info, ok := c.cachedInfo[cacheKey]; ok && time.Since(c.cacheTimestamp[cacheKey]) < c.cacheDuration {
			c.cacheMu.RUnlock()
			return info, nil
		}
		c.cacheMu.RUnlock()
	}

	remember := func(info *UpdateInfo) (*UpdateInfo, error) {
		c.cacheMu.Lock()
		c.cachedInfo[cacheKey] = info
		c.cacheTimestamp[cacheKey] = time.Now()
		c.cacheMu.Unlock()
		return info, nil
	}

	// Development builds carry a version that is not strict semver. They
	// cannot be compared, so updates are simply unavailable.
	if _, err := feed.ParseVersion(currentVersion); err != nil {
		slog.Info("updates unavailable: this build's version is not a release version", "version", currentVersion)
		return remember(noUpdate(currentVersion))
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	res, err := c.fetchFeed(ctx, currentVersion)
	if errors.Is(err, feed.ErrUnknownFormat) {
		slog.Warn("update feed is in a newer format than this version understands; no update offered")
		return remember(noUpdate(currentVersion))
	}
	if err != nil {
		return nil, fmt.Errorf("failed to check for updates: %w", err)
	}

	info := &UpdateInfo{
		CurrentVersion:  currentVersion,
		LatestVersion:   currentVersion,
		UpdateAvailable: res.Update,
	}
	if res.Update {
		info.LatestVersion = res.Feed.Version
		info.ReleaseNotes = res.Feed.Notes
		info.Checksum = res.Part.SHA256
		if t, err := time.Parse(time.RFC3339, res.Feed.Published); err == nil {
			info.PublishedAt = t
		}
	}
	return remember(info)
}

// ApplyUpdate downloads and replaces the current binary with the latest one
func (c *UpdateChecker) ApplyUpdate(ctx context.Context, currentVersion string) error {
	if _, err := feed.ParseVersion(currentVersion); err != nil {
		return fmt.Errorf("no update available: this build's version is not a release version")
	}
	// Always re-read the feed: what gets installed is what was just verified.
	res, err := c.fetchFeed(ctx, currentVersion)
	if err != nil {
		return err
	}
	if !res.Update {
		return fmt.Errorf("no update available")
	}
	newVersion := res.Feed.Version

	// Find current executable path
	execPath := c.exePath
	if execPath == "" {
		execPath, err = os.Executable()
		if err != nil {
			return fmt.Errorf("failed to find current executable: %w", err)
		}
	}

	if err := checkDiskSpace(minDiskSpace); err != nil {
		return fmt.Errorf("insufficient disk space: %w", err)
	}

	// Stage beside the installed binary (same filesystem, so rename works).
	tmpFile, err := os.CreateTemp(filepath.Dir(execPath), ".sol-update-*")
	if err != nil {
		return fmt.Errorf("failed to create temp file: %w", err)
	}
	tmpPath := tmpFile.Name()
	_ = tmpFile.Close()
	defer func() { _ = os.Remove(tmpPath) }()

	dlCtx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	if err := feed.Download(dlCtx, c.downloadClient, res.Part, tmpPath); err != nil {
		return err
	}
	slog.Info("Update download verified", "sha256", res.Part.SHA256)

	if err := os.Chmod(tmpPath, 0755); err != nil {
		return fmt.Errorf("failed to set permissions on update: %w", err)
	}

	// Replace current binary with timeout
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

	// Save update state for post-restart verification
	state := &UpdateState{
		OldVersion: currentVersion,
		NewVersion: newVersion,
		BackupPath: oldPath,
		UpdatedAt:  time.Now(),
		Verified:   false,
	}
	if err := saveUpdateState(state); err != nil {
		slog.Warn("Failed to save update state, rollback won't be available", "error", err)
	}

	// Signal for restart (use channel instead of os.Exit)
	if c.restartCh != nil {
		slog.Info("Update applied successfully, signaling restart",
			"old_version", currentVersion,
			"new_version", newVersion,
		)
		c.restartCh <- RestartSignal{}
	} else {
		// Fallback: exit directly (less graceful)
		go func() {
			slog.Info("Update applied successfully, restarting in 1 second",
				"old_version", currentVersion,
				"new_version", newVersion,
			)
			time.Sleep(1 * time.Second)
			os.Exit(0)
		}()
	}

	return nil
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
