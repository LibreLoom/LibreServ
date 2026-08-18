package restic

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func hasResticBinary(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("restic"); err != nil {
		if _, err := os.Stat("/usr/bin/restic"); err != nil {
			t.Skip("restic binary not available, skipping integration test")
		}
	}
}

func TestDeriveRepoPassword(t *testing.T) {
	p1 := DeriveRepoPassword("secret-key", "app-1")
	p2 := DeriveRepoPassword("secret-key", "app-2")
	p3 := DeriveRepoPassword("secret-key", "app-1")

	if len(p1) != 64 {
		t.Fatalf("expected 64-char hex password, got %d", len(p1))
	}
	if p1 == p2 {
		t.Fatal("different app IDs must produce different passwords")
	}
	if p1 != p3 {
		t.Fatal("same inputs must produce same password")
	}
}

func TestValidateRepoType(t *testing.T) {
	for _, valid := range []string{"local", "s3", "b2", "sftp"} {
		if err := ValidateRepoType(valid); err != nil {
			t.Errorf("expected %q to be valid, got: %v", valid, err)
		}
	}
	if err := ValidateRepoType("ftp"); err == nil {
		t.Error("expected ftp to be invalid")
	}
	if err := ValidateRepoType(""); err == nil {
		t.Error("expected empty string to be invalid")
	}
}

func TestBuildRepoPath(t *testing.T) {
	tests := []struct {
		repoType string
		basePath string
		appID    string
		want     string
	}{
		{"local", "/var/lib/libreserv/backups", "app-1", "/var/lib/libreserv/backups/repos/app-1"},
		{"b2", "my-bucket", "app-1", "b2:app-1"},
		{"s3", "https://s3.amazonaws.com/my-bucket", "app-1", "s3:app-1"},
		{"sftp", "user@host", "app-1", "sftp:app-1"},
		{"unknown", "whatever", "app-1", ""},
	}

	for _, tt := range tests {
		got := BuildRepoPath(tt.repoType, tt.basePath, tt.appID)
		if got != tt.want {
			t.Errorf("BuildRepoPath(%q, %q, %q) = %q, want %q", tt.repoType, tt.basePath, tt.appID, got, tt.want)
		}
	}
}

func TestFindBinary_NoCache(t *testing.T) {
	cachedBinaryPath = ""
	_, err := FindBinary()
	if err != nil {
		t.Log("restic not available on system, FindBinary correctly returns error")
	}
}

func TestEngineInitAndBackup(t *testing.T) {
	hasResticBinary(t)

	tmpDir := t.TempDir()
	repoPath := filepath.Join(tmpDir, "repo")
	password := DeriveRepoPassword("test-secret", "test-app")

	repo := RepoConfig{
		Type:     "local",
		Path:     repoPath,
		Password: password,
	}

	engine, err := NewEngine()
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}

	ctx := context.Background()

	if err := engine.EnsureLocalRepo(ctx, repo); err != nil {
		t.Fatalf("EnsureLocalRepo: %v", err)
	}

	if _, err := os.Stat(filepath.Join(repoPath, "config")); err != nil {
		t.Fatalf("repo config file not created: %v", err)
	}

	dataDir := filepath.Join(tmpDir, "data")
	if err := os.MkdirAll(dataDir, 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "test.txt"), []byte("hello world"), 0644); err != nil {
		t.Fatal(err)
	}

	summary, err := engine.Backup(ctx, repo, []string{dataDir}, []string{"test"}, nil)
	if err != nil {
		t.Fatalf("Backup: %v", err)
	}
	if summary.SnapshotID == "" {
		t.Fatal("expected snapshot ID in backup summary")
	}

	snapshots, err := engine.Snapshots(ctx, repo)
	if err != nil {
		t.Fatalf("Snapshots: %v", err)
	}
	if len(snapshots) == 0 {
		t.Fatal("expected at least one snapshot")
	}

	restoreDir := filepath.Join(tmpDir, "restore")
	if err := os.MkdirAll(restoreDir, 0750); err != nil {
		t.Fatal(err)
	}
	if err := engine.Restore(ctx, repo, snapshots[0].ID, restoreDir, nil); err != nil {
		t.Fatalf("Restore: %v", err)
	}
	restoredFile := filepath.Join(restoreDir, dataDir, "test.txt")
	data, err := os.ReadFile(restoredFile)
	if err != nil {
		t.Fatalf("read restored file: %v", err)
	}
	if string(data) != "hello world" {
		t.Fatalf("restored content mismatch: got %q", string(data))
	}

	if err := engine.Check(ctx, repo); err != nil {
		t.Fatalf("Check: %v", err)
	}
}

func TestEngineForget(t *testing.T) {
	hasResticBinary(t)

	tmpDir := t.TempDir()
	repoPath := filepath.Join(tmpDir, "repo")
	password := DeriveRepoPassword("test-secret", "forget-app")

	repo := RepoConfig{
		Type:     "local",
		Path:     repoPath,
		Password: password,
	}

	engine, err := NewEngine()
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}

	ctx := context.Background()
	if err := engine.EnsureLocalRepo(ctx, repo); err != nil {
		t.Fatalf("EnsureLocalRepo: %v", err)
	}

	dataDir := filepath.Join(tmpDir, "data")
	if err := os.MkdirAll(dataDir, 0750); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 3; i++ {
		if err := os.WriteFile(filepath.Join(dataDir, "file.txt"), []byte("content"), 0644); err != nil {
			t.Fatal(err)
		}
		if _, err := engine.Backup(ctx, repo, []string{dataDir}, []string{"test"}, nil); err != nil {
			t.Fatalf("Backup %d: %v", i, err)
		}
	}

	snapshots, err := engine.Snapshots(ctx, repo)
	if err != nil {
		t.Fatalf("Snapshots: %v", err)
	}
	if len(snapshots) != 3 {
		t.Fatalf("expected 3 snapshots, got %d", len(snapshots))
	}

	result, err := engine.Forget(ctx, repo, 2, 0, 0, 0)
	if err != nil {
		t.Fatalf("Forget: %v", err)
	}

	snapshots, err = engine.Snapshots(ctx, repo)
	if err != nil {
		t.Fatalf("Snapshots after forget: %v", err)
	}
	if len(snapshots) != 2 {
		t.Fatalf("expected 2 snapshots after forget, got %d", len(snapshots))
	}
	_ = result
}

func TestEngineStats(t *testing.T) {
	hasResticBinary(t)

	tmpDir := t.TempDir()
	repoPath := filepath.Join(tmpDir, "repo")
	password := DeriveRepoPassword("test-secret", "stats-app")

	repo := RepoConfig{
		Type:     "local",
		Path:     repoPath,
		Password: password,
	}

	engine, err := NewEngine()
	if err != nil {
		t.Fatalf("NewEngine: %v", err)
	}

	ctx := context.Background()
	if err := engine.EnsureLocalRepo(ctx, repo); err != nil {
		t.Fatalf("EnsureLocalRepo: %v", err)
	}

	dataDir := filepath.Join(tmpDir, "data")
	if err := os.MkdirAll(dataDir, 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataDir, "stats.txt"), []byte("stats content"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := engine.Backup(ctx, repo, []string{dataDir}, []string{"test"}, nil); err != nil {
		t.Fatalf("Backup: %v", err)
	}

	stats, err := engine.Stats(ctx, repo)
	if err != nil {
		t.Fatalf("Stats: %v", err)
	}
	if stats == nil {
		t.Fatal("expected non-nil stats")
	}
}

func TestPathValidation(t *testing.T) {
	engine, err := NewEngine()
	if err != nil {
		t.Skip("restic not available")
	}

	ctx := context.Background()
	repo := RepoConfig{Type: "local", Path: "/tmp/nonexistent", Password: "test"}

	_, err = engine.Backup(ctx, repo, []string{"/valid/path"}, []string{"; rm -rf /"}, nil)
	if err == nil {
		t.Fatal("expected error for invalid tag")
	}

	_, err = engine.Backup(ctx, repo, []string{"$(whoami)"}, []string{"tag"}, nil)
	if err == nil {
		t.Fatal("expected error for invalid path")
	}
}
