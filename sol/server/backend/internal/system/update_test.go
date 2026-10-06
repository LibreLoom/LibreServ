package system

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"aead.dev/minisign"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/feed"
)

// memStore is an in-memory StateStore.
type memStore struct {
	mu sync.Mutex
	m  map[string]string
}

func newMemStore() *memStore { return &memStore{m: map[string]string{}} }

func (s *memStore) Get(k string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.m[k], nil
}

func (s *memStore) Set(k, v, _ string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.m[k] = v
	return nil
}

// feedServer serves a signed Sol feed for the "stable" channel plus the binary.
type feedServer struct {
	*httptest.Server
	pub       minisign.PublicKey
	priv      minisign.PrivateKey
	hits      int
	payload   []byte
	version   string
	published string
	unit      string
	arch      string
	sigPriv   *minisign.PrivateKey // overrides the signing key when set
}

func newFeedServer(t *testing.T) *feedServer {
	t.Helper()
	pub, priv, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	fs := &feedServer{
		pub: pub, priv: priv,
		payload:   []byte("libreserv-new-binary"),
		version:   "2.0.0",
		published: "2026-10-12T14:03:00Z",
		unit:      "sol",
		arch:      "amd64",
	}
	mux := http.NewServeMux()
	feedBody := func() []byte {
		sum := sha256.Sum256(fs.payload)
		doc := map[string]any{
			"format": 1, "unit": fs.unit, "channel": "stable",
			"version": fs.version, "published": fs.published, "notes": "Notes here",
			"future_field": true,
			"parts": []map[string]any{{
				"name": "sol", "os": "linux", "arch": fs.arch,
				"file": "libreserv-linux-" + fs.arch, "size": len(fs.payload),
				"sha256": hex.EncodeToString(sum[:]),
				"urls":   []string{fs.Server.URL + "/generic/sol/" + fs.version + "/libreserv-linux-" + fs.arch},
			}},
		}
		b, _ := json.Marshal(doc)
		return b
	}
	mux.HandleFunc("/feeds/sol/stable.json", func(w http.ResponseWriter, r *http.Request) {
		fs.hits++
		_, _ = w.Write(feedBody())
	})
	mux.HandleFunc("/feeds/sol/stable.json.minisig", func(w http.ResponseWriter, r *http.Request) {
		key := fs.priv
		if fs.sigPriv != nil {
			key = *fs.sigPriv
		}
		_, _ = w.Write(minisign.Sign(key, feedBody()))
	})
	mux.HandleFunc("/generic/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(fs.payload)
	})
	fs.Server = httptest.NewServer(mux)
	t.Cleanup(fs.Close)
	return fs
}

func (fs *feedServer) checker() *UpdateChecker {
	c := NewUpdateChecker(config.UpdatesConfig{FeedURL: fs.URL + "/feeds/sol", Channel: "stable"})
	c.pinnedKeys = []minisign.PublicKey{fs.pub}
	c.arch = "amd64"
	c.SetStateStore(newMemStore())
	return c
}

func TestCheckForUpdates_UpdateAvailable(t *testing.T) {
	fs := newFeedServer(t)
	info, err := fs.checker().CheckForUpdates("1.0.0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !info.UpdateAvailable || info.LatestVersion != "2.0.0" || info.ReleaseNotes != "Notes here" {
		t.Fatalf("unexpected info: %+v", info)
	}
	if info.PublishedAt.IsZero() {
		t.Error("expected published time")
	}
	b, _ := json.Marshal(info)
	if strings.Contains(string(b), `"url"`) {
		t.Errorf("response should not carry a url: %s", b)
	}
}

func TestCheckForUpdates_NoUpdate(t *testing.T) {
	for _, cur := range []string{"2.0.0", "3.0.0"} {
		fs := newFeedServer(t)
		info, err := fs.checker().CheckForUpdates(cur)
		if err != nil {
			t.Fatalf("%s: %v", cur, err)
		}
		if info.UpdateAvailable || info.LatestVersion != cur {
			t.Errorf("%s: unexpected info %+v", cur, info)
		}
	}
}

func TestCheckForUpdates_BetaOrdering(t *testing.T) {
	fs := newFeedServer(t)
	fs.version = "0.3.0"
	info, err := fs.checker().CheckForUpdates("0.3.0-beta.10")
	if err != nil || !info.UpdateAvailable {
		t.Fatalf("0.3.0 should beat 0.3.0-beta.10: %+v %v", info, err)
	}
}

func TestCheckForUpdates_NonSemverBuildHasNoUpdates(t *testing.T) {
	fs := newFeedServer(t)
	for _, v := range []string{"dev", "v1.0.0", "1.2.3.4", "abc1234", ""} {
		info, err := fs.checker().CheckForUpdates(v)
		if err != nil {
			t.Fatalf("%q: %v", v, err)
		}
		if info.UpdateAvailable {
			t.Errorf("%q: should not offer updates", v)
		}
	}
	if fs.hits != 0 {
		t.Errorf("feed should not be fetched for non-semver builds, hits=%d", fs.hits)
	}
}

func TestCheckForUpdates_RejectsBadSignature(t *testing.T) {
	fs := newFeedServer(t)
	_, other, _ := minisign.GenerateKey(rand.Reader)
	fs.sigPriv = &other
	_, err := fs.checker().CheckForUpdates("1.0.0")
	if !errors.Is(err, feed.ErrBadSignature) {
		t.Fatalf("err = %v, want bad signature", err)
	}
}

func TestCheckForUpdates_RejectsWrongUnit(t *testing.T) {
	fs := newFeedServer(t)
	fs.unit = "luna"
	_, err := fs.checker().CheckForUpdates("1.0.0")
	if !errors.Is(err, feed.ErrWrongUnit) {
		t.Fatalf("err = %v, want wrong unit", err)
	}
}

func TestCheckForUpdates_MissingArch(t *testing.T) {
	fs := newFeedServer(t)
	fs.arch = "arm64"
	_, err := fs.checker().CheckForUpdates("1.0.0")
	if !errors.Is(err, feed.ErrMissingPart) {
		t.Fatalf("err = %v, want missing part", err)
	}
}

func TestCheckForUpdates_ReplayAndNewestSeen(t *testing.T) {
	fs := newFeedServer(t)
	c := fs.checker()
	store := newMemStore()
	c.SetStateStore(store)

	if _, err := c.CheckForUpdates("1.0.0", true); err != nil {
		t.Fatal(err)
	}
	if got, _ := store.Get("updates.newest_published.sol.stable"); got != "2026-10-12T14:03:00Z" {
		t.Fatalf("stored newest = %q", got)
	}
	// Equal is fine.
	if _, err := c.CheckForUpdates("1.0.0", true); err != nil {
		t.Fatalf("equal published rejected: %v", err)
	}
	// An older signed feed is a replay.
	fs.published = "2026-10-01T00:00:00Z"
	if _, err := c.CheckForUpdates("1.0.0", true); !errors.Is(err, feed.ErrReplayed) {
		t.Fatalf("err = %v, want replayed", err)
	}
	// Another channel keeps its own record.
	if got, _ := store.Get("updates.newest_published.sol.beta"); got != "" {
		t.Fatalf("beta record should be empty, got %q", got)
	}
}

func TestCheckForUpdates_NetworkError(t *testing.T) {
	c := NewUpdateChecker(config.UpdatesConfig{FeedURL: "http://127.0.0.1:1/feeds/sol", Channel: "stable"})
	if _, err := c.CheckForUpdates("1.0.0"); err == nil {
		t.Fatal("expected error")
	}
}

func TestCheckForUpdates_FeedNotFound(t *testing.T) {
	srv := httptest.NewServer(http.NotFoundHandler())
	defer srv.Close()
	c := NewUpdateChecker(config.UpdatesConfig{FeedURL: srv.URL, Channel: "stable"})
	if _, err := c.CheckForUpdates("1.0.0"); err == nil {
		t.Fatal("expected error")
	}
}

func TestCheckForUpdates_CachingAndChannel(t *testing.T) {
	fs := newFeedServer(t)
	c := fs.checker()
	c.cacheDuration = 5 * time.Minute

	for range 2 {
		if _, err := c.CheckForUpdates("1.0.0"); err != nil {
			t.Fatal(err)
		}
	}
	if fs.hits != 1 {
		t.Fatalf("expected 1 feed fetch (cached), got %d", fs.hits)
	}
	c.ClearCache()
	if _, err := c.CheckForUpdates("1.0.0"); err != nil {
		t.Fatal(err)
	}
	if fs.hits != 2 {
		t.Fatalf("expected 2 fetches after cache clear, got %d", fs.hits)
	}
	// Switching channel drops the cache and rejects unknown names.
	if err := c.SetChannel("nightly"); err == nil {
		t.Fatal("unknown channel accepted")
	}
	if err := c.SetChannel("beta"); err != nil || c.Channel() != "beta" {
		t.Fatalf("SetChannel beta: %v %q", err, c.Channel())
	}
}

func TestCheckForUpdates_CacheExpiration(t *testing.T) {
	fs := newFeedServer(t)
	c := fs.checker()
	c.cacheDuration = time.Millisecond
	_, _ = c.CheckForUpdates("1.0.0")
	time.Sleep(3 * time.Millisecond)
	_, _ = c.CheckForUpdates("1.0.0")
	if fs.hits != 2 {
		t.Fatalf("expected 2 fetches after expiry, got %d", fs.hits)
	}
}

func TestNewUpdateChecker_DefaultsToStable(t *testing.T) {
	if got := NewUpdateChecker(config.UpdatesConfig{}).Channel(); got != "stable" {
		t.Fatalf("channel = %q", got)
	}
}

func TestSetCacheDuration(t *testing.T) {
	checker := NewUpdateChecker(config.UpdatesConfig{})
	if checker.cacheDuration != defaultCacheDuration {
		t.Errorf("default cache duration = %v, want %v", checker.cacheDuration, defaultCacheDuration)
	}
	checker.SetCacheDuration(30 * time.Minute)
	if checker.cacheDuration != 30*time.Minute {
		t.Errorf("cache duration after set = %v, want 30m", checker.cacheDuration)
	}
}

func TestClearCache(t *testing.T) {
	fs := newFeedServer(t)
	c := fs.checker()
	_, _ = c.CheckForUpdates("0.9.0")
	c.cacheMu.RLock()
	if len(c.cachedInfo) == 0 {
		t.Fatal("expected cached info after CheckForUpdates")
	}
	c.cacheMu.RUnlock()
	c.ClearCache()
	c.cacheMu.RLock()
	defer c.cacheMu.RUnlock()
	if len(c.cachedInfo) != 0 {
		t.Error("expected empty cache after ClearCache")
	}
}

func TestApplyUpdate_NoUpdateAvailable(t *testing.T) {
	fs := newFeedServer(t)
	err := fs.checker().ApplyUpdate(t.Context(), "2.0.0")
	if err == nil || err.Error() != "no update available" {
		t.Fatalf("err = %v, want 'no update available'", err)
	}
}

func TestApplyUpdate_StagesBesideBinaryAndReplaces(t *testing.T) {
	stateDir := t.TempDir()
	old, oldFallback := updateStateDirFallback, updateStateDirFallback
	updateStateDirFallback = stateDir
	defer func() { updateStateDirFallback = old; _ = oldFallback }()

	fs := newFeedServer(t)
	c := fs.checker()
	dir := t.TempDir()
	c.exePath = filepath.Join(dir, "libreserv")
	if err := os.WriteFile(c.exePath, []byte("old-binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	restart := make(chan RestartSignal, 1)
	c.SetRestartChannel(restart)

	if err := c.ApplyUpdate(context.Background(), "1.0.0"); err != nil {
		t.Fatalf("apply: %v", err)
	}
	got, _ := os.ReadFile(c.exePath)
	if string(got) != string(fs.payload) {
		t.Fatalf("binary = %q", got)
	}
	if old, _ := os.ReadFile(c.exePath + ".old"); string(old) != "old-binary" {
		t.Fatalf("backup = %q", old)
	}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".libreserv-update-") {
			t.Errorf("staging file left behind: %s", e.Name())
		}
	}
	select {
	case <-restart:
	default:
		t.Error("expected restart signal")
	}
}

func TestApplyUpdate_ChecksumMismatchLeavesBinaryAlone(t *testing.T) {
	fs := newFeedServer(t)
	c := fs.checker()
	dir := t.TempDir()
	c.exePath = filepath.Join(dir, "libreserv")
	_ = os.WriteFile(c.exePath, []byte("old-binary"), 0o755)

	// Serve different bytes than the feed's sha256 promises (same length).
	bad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", len(fs.payload))))
	}))
	defer bad.Close()
	c.downloadClient = &http.Client{Transport: rewriteTo(bad.URL)}

	err := c.ApplyUpdate(context.Background(), "1.0.0")
	if !errors.Is(err, feed.ErrShaMismatch) {
		t.Fatalf("err = %v, want sha mismatch", err)
	}
	if got, _ := os.ReadFile(c.exePath); string(got) != "old-binary" {
		t.Fatalf("binary changed: %q", got)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 1 {
		t.Errorf("staging file left behind: %v", entries)
	}
}

type rewriteTransport struct{ target string }

func rewriteTo(target string) http.RoundTripper { return rewriteTransport{target} }

func (r rewriteTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	u := *req.URL
	t, _ := http.NewRequest(req.Method, r.target+u.Path, nil)
	return http.DefaultTransport.RoundTrip(t.WithContext(req.Context()))
}

var _ = fmt.Sprintf

func TestUpdateState_SaveAndLoad(t *testing.T) {
	tmpDir := t.TempDir()
	oldStateDir := updateStateDir
	oldStateFile := updateStateFile
	updateStateDir = tmpDir
	updateStateFile = "test_state.json"
	defer func() {
		updateStateDir = oldStateDir
		updateStateFile = oldStateFile
	}()

	state := &UpdateState{
		OldVersion: "1.0.0",
		NewVersion: "2.0.0",
		BackupPath: "/path/to/backup",
		UpdatedAt:  time.Now(),
		Verified:   false,
	}

	if err := saveUpdateState(state); err != nil {
		t.Fatalf("saveUpdateState failed: %v", err)
	}

	loaded, err := loadUpdateState()
	if err != nil {
		t.Fatalf("loadUpdateState failed: %v", err)
	}
	if loaded == nil {
		t.Fatal("loaded state is nil")
	}
	if loaded.OldVersion != "1.0.0" {
		t.Errorf("old version = %q, want 1.0.0", loaded.OldVersion)
	}
	if loaded.NewVersion != "2.0.0" {
		t.Errorf("new version = %q, want 2.0.0", loaded.NewVersion)
	}
	if loaded.BackupPath != "/path/to/backup" {
		t.Errorf("backup path = %q, want /path/to/backup", loaded.BackupPath)
	}
	if loaded.Verified {
		t.Error("expected verified to be false")
	}
}

func TestUpdateState_LoadNonExistent(t *testing.T) {
	tmpDir := t.TempDir()
	oldStateDir := updateStateDir
	oldStateFile := updateStateFile
	updateStateDir = tmpDir
	updateStateFile = "nonexistent.json"
	defer func() {
		updateStateDir = oldStateDir
		updateStateFile = oldStateFile
	}()

	state, err := loadUpdateState()
	if err != nil {
		t.Fatalf("expected nil error for non-existent file, got %v", err)
	}
	if state != nil {
		t.Error("expected nil state for non-existent file")
	}
}

func TestUpdateState_Delete(t *testing.T) {
	tmpDir := t.TempDir()
	oldStateDir := updateStateDir
	oldStateFile := updateStateFile
	updateStateDir = tmpDir
	updateStateFile = "test_delete.json"
	defer func() {
		updateStateDir = oldStateDir
		updateStateFile = oldStateFile
	}()

	state := &UpdateState{OldVersion: "1.0.0", NewVersion: "2.0.0"}
	_ = saveUpdateState(state)

	if err := deleteUpdateState(); err != nil {
		t.Fatalf("deleteUpdateState failed: %v", err)
	}

	loaded, err := loadUpdateState()
	if err != nil {
		t.Fatalf("unexpected error after delete: %v", err)
	}
	if loaded != nil {
		t.Error("expected nil state after delete")
	}
}

func TestCheckHealth_Success(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	if !checkHealth(server.URL) {
		t.Error("expected health check to succeed")
	}
}

func TestCheckHealth_Failure(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	if checkHealth(server.URL) {
		t.Error("expected health check to fail")
	}
}

func TestCheckHealth_NetworkError(t *testing.T) {
	if checkHealth("http://127.0.0.1:1") {
		t.Error("expected health check to fail on network error")
	}
}

func TestVerifyAndUpdate_NoStateFile(t *testing.T) {
	tmpDir := t.TempDir()
	oldStateDir := updateStateDir
	oldStateFile := updateStateFile
	updateStateDir = tmpDir
	updateStateFile = "test_state.json"
	defer func() {
		updateStateDir = oldStateDir
		updateStateFile = oldStateFile
	}()

	rolledBack, err := VerifyAndUpdate("http://127.0.0.1:1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rolledBack {
		t.Error("expected no rollback when no state file exists")
	}
}

func TestVerifyAndUpdate_AlreadyVerified(t *testing.T) {
	tmpDir := t.TempDir()
	oldStateDir := updateStateDir
	oldStateFile := updateStateFile
	updateStateDir = tmpDir
	updateStateFile = "test_state.json"
	defer func() {
		updateStateDir = oldStateDir
		updateStateFile = oldStateFile
	}()

	state := &UpdateState{
		OldVersion: "1.0.0",
		NewVersion: "2.0.0",
		Verified:   true,
	}
	_ = saveUpdateState(state)

	rolledBack, err := VerifyAndUpdate("http://127.0.0.1:1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rolledBack {
		t.Error("expected no rollback when already verified")
	}
}

func TestVerifyAndUpdate_TimeoutExceeded(t *testing.T) {
	tmpDir := t.TempDir()
	oldStateDir := updateStateDir
	oldStateFile := updateStateFile
	updateStateDir = tmpDir
	updateStateFile = "test_state.json"
	defer func() {
		updateStateDir = oldStateDir
		updateStateFile = oldStateFile
	}()

	state := &UpdateState{
		OldVersion: "1.0.0",
		NewVersion: "2.0.0",
		UpdatedAt:  time.Now().Add(-10 * time.Minute),
		Verified:   false,
	}
	_ = saveUpdateState(state)

	rolledBack, err := VerifyAndUpdate("http://127.0.0.1:1")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rolledBack {
		t.Error("expected no rollback when timeout exceeded")
	}

	loaded, _ := loadUpdateState()
	if loaded != nil {
		t.Error("expected state file to be deleted after timeout verification")
	}
}

func TestVerifyAndUpdate_HealthCheckFailure(t *testing.T) {
	tmpDir := t.TempDir()
	oldStateDir := updateStateDir
	oldStateFile := updateStateFile
	updateStateDir = tmpDir
	updateStateFile = "test_state.json"
	defer func() {
		updateStateDir = oldStateDir
		updateStateFile = oldStateFile
	}()

	state := &UpdateState{
		OldVersion: "1.0.0",
		NewVersion: "2.0.0",
		UpdatedAt:  time.Now(),
		Verified:   false,
	}
	_ = saveUpdateState(state)

	// Health check should fail (no server running)
	rolledBack, err := VerifyAndUpdate("http://127.0.0.1:1")
	if err != nil {
		t.Fatalf("VerifyAndUpdate should not return error on health check failure: %v", err)
	}
	if rolledBack {
		t.Error("expected no rollback when backup doesn't exist")
	}

	// State should be deleted even on failure
	loaded, _ := loadUpdateState()
	if loaded != nil {
		t.Error("expected state file to be deleted after failed verification")
	}
}

func TestVerifyAndUpdate_HealthCheckSuccess(t *testing.T) {
	tmpDir := t.TempDir()
	oldStateDir := updateStateDir
	oldStateFile := updateStateFile
	updateStateDir = tmpDir
	updateStateFile = "test_state.json"
	defer func() {
		updateStateDir = oldStateDir
		updateStateFile = oldStateFile
	}()

	// Create a mock health endpoint
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/v1/health" {
			w.WriteHeader(http.StatusOK)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer server.Close()

	state := &UpdateState{
		OldVersion: "1.0.0",
		NewVersion: "2.0.0",
		UpdatedAt:  time.Now(),
		Verified:   false,
	}
	_ = saveUpdateState(state)

	rolledBack, err := VerifyAndUpdate(server.URL)
	if err != nil {
		t.Fatalf("VerifyAndUpdate should succeed on health check success: %v", err)
	}
	if rolledBack {
		t.Error("expected no rollback when health check passes")
	}

	// State should be deleted after successful verification
	loaded, _ := loadUpdateState()
	if loaded != nil {
		t.Error("expected state file to be deleted after successful verification")
	}
}
