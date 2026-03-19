package system

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func newTestChecker(baseURL string) *UpdateChecker {
	c := NewUpdateChecker("owner", "repo")
	c.baseURL = baseURL
	return c
}

func TestCheckForUpdates_NoReleases(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, "[]")
	}))
	defer server.Close()

	checker := newTestChecker(server.URL)

	info, err := checker.CheckForUpdates("1.0.0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info.UpdateAvailable {
		t.Error("expected no update available when there are no releases")
	}
	if info.CurrentVersion != "1.0.0" {
		t.Errorf("current version = %q, want 1.0.0", info.CurrentVersion)
	}
	if info.LatestVersion != "1.0.0" {
		t.Errorf("latest version = %q, want 1.0.0", info.LatestVersion)
	}
}

func TestCheckForUpdates_UpdateAvailable(t *testing.T) {
	release := giteaRelease{
		TagName:     "v2.0.0",
		Name:        "Release 2.0.0",
		Body:        "Major release",
		PublishedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
		HTMLURL:     "https://example.com/releases/v2.0.0",
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]giteaRelease{release})
	}))
	defer server.Close()

	checker := newTestChecker(server.URL)

	info, err := checker.CheckForUpdates("1.0.0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !info.UpdateAvailable {
		t.Error("expected update available")
	}
	if info.LatestVersion != "v2.0.0" {
		t.Errorf("latest version = %q, want v2.0.0", info.LatestVersion)
	}
	if info.CurrentVersion != "1.0.0" {
		t.Errorf("current version = %q, want 1.0.0", info.CurrentVersion)
	}
	if info.ReleaseNotes != "Major release" {
		t.Errorf("release notes = %q, want 'Major release'", info.ReleaseNotes)
	}
	if info.URL != "https://example.com/releases/v2.0.0" {
		t.Errorf("url = %q, want https://example.com/releases/v2.0.0", info.URL)
	}
}

func TestCheckForUpdates_NoUpdateSameVersion(t *testing.T) {
	release := giteaRelease{TagName: "v1.0.0"}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]giteaRelease{release})
	}))
	defer server.Close()

	checker := newTestChecker(server.URL)

	info, err := checker.CheckForUpdates("1.0.0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info.UpdateAvailable {
		t.Error("expected no update when versions match")
	}
}

func TestCheckForUpdates_DevVersionAlwaysShowsUpdate(t *testing.T) {
	release := giteaRelease{TagName: "v1.0.0"}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]giteaRelease{release})
	}))
	defer server.Close()

	checker := newTestChecker(server.URL)

	info, err := checker.CheckForUpdates("dev")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info.UpdateAvailable {
		t.Error("dev version should never show update available")
	}
}

func TestCheckForUpdates_StripsVPrefix(t *testing.T) {
	release := giteaRelease{TagName: "v1.5.0"}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]giteaRelease{release})
	}))
	defer server.Close()

	checker := newTestChecker(server.URL)

	// v prefix on current version should be handled
	info, err := checker.CheckForUpdates("v1.5.0")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if info.UpdateAvailable {
		t.Error("expected no update when versions match (v-prefix stripped)")
	}
}

func TestCheckForUpdates_APIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	checker := newTestChecker(server.URL)

	_, err := checker.CheckForUpdates("1.0.0")
	if err == nil {
		t.Fatal("expected error for non-200 status")
	}
}

func TestCheckForUpdates_NetworkError(t *testing.T) {
	checker := NewUpdateChecker("owner", "repo")
	checker.baseURL = "http://127.0.0.1:1" // port 1 should refuse connections

	_, err := checker.CheckForUpdates("1.0.0")
	if err == nil {
		t.Fatal("expected error for network failure")
	}
}

func TestCheckForUpdates_InvalidJSON(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, "not json")
	}))
	defer server.Close()

	checker := newTestChecker(server.URL)

	_, err := checker.CheckForUpdates("1.0.0")
	if err == nil {
		t.Fatal("expected error for invalid JSON")
	}
}

func TestCheckForUpdates_Caching(t *testing.T) {
	callCount := 0
	release := giteaRelease{TagName: "v2.0.0"}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]giteaRelease{release})
	}))
	defer server.Close()

	checker := newTestChecker(server.URL)
	checker.cacheDuration = 5 * time.Minute

	// First call should hit the server
	_, err := checker.CheckForUpdates("1.0.0")
	if err != nil {
		t.Fatalf("first call: %v", err)
	}
	if callCount != 1 {
		t.Fatalf("expected 1 server call, got %d", callCount)
	}

	// Second call should use cache
	_, err = checker.CheckForUpdates("1.0.0")
	if err != nil {
		t.Fatalf("second call: %v", err)
	}
	if callCount != 1 {
		t.Fatalf("expected 1 server call (cached), got %d", callCount)
	}

	// After clearing cache, should hit server again
	checker.ClearCache()
	_, err = checker.CheckForUpdates("1.0.0")
	if err != nil {
		t.Fatalf("third call: %v", err)
	}
	if callCount != 2 {
		t.Fatalf("expected 2 server calls after cache clear, got %d", callCount)
	}
}

func TestCheckForUpdates_CacheExpiration(t *testing.T) {
	callCount := 0
	release := giteaRelease{TagName: "v2.0.0"}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		callCount++
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]giteaRelease{release})
	}))
	defer server.Close()

	checker := newTestChecker(server.URL)
	checker.cacheDuration = 1 * time.Millisecond // near-instant expiry

	checker.CheckForUpdates("1.0.0")
	if callCount != 1 {
		t.Fatalf("expected 1 call, got %d", callCount)
	}

	time.Sleep(2 * time.Millisecond)

	checker.CheckForUpdates("1.0.0")
	if callCount != 2 {
		t.Fatalf("expected 2 calls after cache expiry, got %d", callCount)
	}
}

func TestSetCacheDuration(t *testing.T) {
	checker := NewUpdateChecker("owner", "repo")
	if checker.cacheDuration != defaultCacheDuration {
		t.Errorf("default cache duration = %v, want %v", checker.cacheDuration, defaultCacheDuration)
	}

	checker.SetCacheDuration(30 * time.Minute)
	if checker.cacheDuration != 30*time.Minute {
		t.Errorf("cache duration after set = %v, want 30m", checker.cacheDuration)
	}
}

func TestClearCache(t *testing.T) {
	release := giteaRelease{TagName: "v1.0.0"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]giteaRelease{release})
	}))
	defer server.Close()

	checker := newTestChecker(server.URL)
	checker.cacheDuration = 5 * time.Minute

	checker.CheckForUpdates("0.9.0")

	// Cache should have data
	checker.cacheMu.RLock()
	if checker.cachedInfo == nil {
		t.Fatal("expected cached info after CheckForUpdates")
	}
	checker.cacheMu.RUnlock()

	checker.ClearCache()

	checker.cacheMu.RLock()
	if checker.cachedInfo != nil {
		t.Error("expected nil cached info after ClearCache")
	}
	checker.cacheMu.RUnlock()
}

func TestApplyUpdate_NoUpdateAvailable(t *testing.T) {
	release := giteaRelease{TagName: "v1.0.0"}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode([]giteaRelease{release})
	}))
	defer server.Close()

	checker := newTestChecker(server.URL)

	err := checker.ApplyUpdate(t.Context(), "1.0.0")
	if err == nil {
		t.Fatal("expected error when no update available")
	}
	if err.Error() != "no update available" {
		t.Errorf("error = %q, want 'no update available'", err.Error())
	}
}
