package apps

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

func TestNewRepoSet_Empty(t *testing.T) {
	rs, err := NewRepoSet(nil, []config.RepoConfig{}, t.TempDir(), 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rs == nil {
		t.Fatal("expected non-nil RepoSet")
	}

	statuses := rs.RepoStatus()
	if len(statuses) != 0 {
		t.Fatalf("expected 0 statuses, got %d", len(statuses))
	}

	cat := rs.GetCatalog()
	if cat != nil {
		t.Fatalf("expected nil catalog for empty reposet, got %+v", cat)
	}
}

func TestNewRepoSet_SortedByPriority(t *testing.T) {
	configs := []config.RepoConfig{
		{URL: "https://example.com/low", Branch: "main", Enabled: true, Priority: 10},
		{URL: "https://example.com/high", Branch: "main", Enabled: true, Priority: 1},
		{URL: "https://example.com/mid", Branch: "main", Enabled: true, Priority: 5},
	}

	rs, err := NewRepoSet(nil, configs, t.TempDir(), 0)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	statuses := rs.RepoStatus()
	if len(statuses) != 3 {
		t.Fatalf("expected 3 statuses, got %d", len(statuses))
	}

	if statuses[0].Priority != 1 {
		t.Fatalf("expected first status priority=1, got %d", statuses[0].Priority)
	}
	if statuses[1].Priority != 5 {
		t.Fatalf("expected second status priority=5, got %d", statuses[1].Priority)
	}
	if statuses[2].Priority != 10 {
		t.Fatalf("expected third status priority=10, got %d", statuses[2].Priority)
	}
}

func TestRepoSet_GetCatalog(t *testing.T) {
	rs, _ := NewRepoSet(nil, []config.RepoConfig{}, t.TempDir(), 0)

	cat := rs.GetCatalog()
	if cat != nil {
		t.Fatalf("expected nil catalog, got %+v", cat)
	}
}

func TestRepoSet_GetManifest_NoCatalog(t *testing.T) {
	rs, _ := NewRepoSet(nil, []config.RepoConfig{}, t.TempDir(), 0)

	_, err := rs.GetManifest("someapp")
	if err == nil {
		t.Fatal("expected error when catalog is nil")
	}
}

func TestRepoSet_StartStop(t *testing.T) {
	rs, _ := NewRepoSet(nil, []config.RepoConfig{}, t.TempDir(), 0)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := rs.Start(ctx); err != nil {
		t.Fatalf("start: %v", err)
	}

	rs.Stop()
}

func TestRepoSet_DoubleStart(t *testing.T) {
	rs, _ := NewRepoSet(nil, []config.RepoConfig{}, t.TempDir(), 0)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := rs.Start(ctx); err != nil {
		t.Fatalf("first start: %v", err)
	}
	if err := rs.Start(ctx); err != nil {
		t.Fatalf("second start: %v", err)
	}

	rs.Stop()
}

func TestRepoClient_AppsPath(t *testing.T) {
	cfg := config.RepoConfig{URL: "https://example.com/repo", Branch: "main", Enabled: true, Priority: 1}
	client := NewRepoClient(nil, cfg, "/tmp/test-repo-0")

	expected := filepath.Join("/tmp/test-repo-0", "apps")
	if got := client.AppsPath(); got != expected {
		t.Fatalf("expected %s, got %s", expected, got)
	}
}

func TestRepoClient_InitialState(t *testing.T) {
	cfg := config.RepoConfig{URL: "https://example.com/repo", Branch: "main", Enabled: true, Priority: 1}
	client := NewRepoClient(nil, cfg, t.TempDir())

	if !client.LastPull().IsZero() {
		t.Fatal("expected zero last pull time")
	}
	if client.LastCommit() != "" {
		t.Fatal("expected empty last commit")
	}
	if client.LastError() != nil {
		t.Fatalf("expected nil last error, got %v", client.LastError())
	}
}
