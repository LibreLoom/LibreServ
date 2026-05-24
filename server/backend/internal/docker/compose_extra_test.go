package docker

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestGetComposeArgs(t *testing.T) {
	cm := &ComposeManager{}
	file, dir := cm.getComposeArgs("/tmp/project/docker-compose.yml")
	if file != "/tmp/project/docker-compose.yml" || dir != "/tmp/project" {
		t.Fatalf("unexpected compose args for file: %q, %q", file, dir)
	}
	file, dir = cm.getComposeArgs("/tmp/project")
	if file != "/tmp/project/docker-compose.yml" || dir != "/tmp/project" {
		t.Fatalf("unexpected compose args for dir: %q, %q", file, dir)
	}
}

func TestExtractBindMountPaths(t *testing.T) {
	dir := t.TempDir()
	composePath := filepath.Join(dir, "docker-compose.yml")
	if err := os.WriteFile(composePath, []byte(`
services:
  app:
    image: alpine
    volumes:
      - /data/app/config:/etc/app:rw,z
      - /data/app/data:/var/lib/app:z
      - named-vol:/internal
  redis:
    image: redis
    volumes:
      - /data/app/redis:/data:z
volumes:
  named-vol:
`), 0o644); err != nil {
		t.Fatalf("write compose: %v", err)
	}

	paths, err := extractBindMountPaths(composePath)
	if err != nil {
		t.Fatalf("extractBindMountPaths: %v", err)
	}

	expected := []string{"/data/app/config", "/data/app/data", "/data/app/redis"}
	if len(paths) != len(expected) {
		t.Fatalf("expected %d paths, got %d: %v", len(expected), len(paths), paths)
	}

	for _, want := range expected {
		found := false
		for _, got := range paths {
			if got == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("missing expected path %s in %v", want, paths)
		}
	}
}

func TestExtractBindMountPathsEmpty(t *testing.T) {
	dir := t.TempDir()
	composePath := filepath.Join(dir, "docker-compose.yml")
	if err := os.WriteFile(composePath, []byte(`
services:
  app:
    image: alpine
`), 0o644); err != nil {
		t.Fatalf("write compose: %v", err)
	}

	paths, err := extractBindMountPaths(composePath)
	if err != nil {
		t.Fatalf("extractBindMountPaths: %v", err)
	}
	if len(paths) != 0 {
		t.Fatalf("expected no paths for compose without volumes, got %v", paths)
	}
}

func TestChownBindMountsMissingFile(t *testing.T) {
	ctx := context.Background()
	err := ChownBindMounts(ctx, "/nonexistent/docker-compose.yml", 1000, 1000)
	if err == nil {
		t.Fatal("expected error for missing compose file")
	}
}

func TestChownDirMissingPath(t *testing.T) {
	ctx := context.Background()
	err := ChownDir(ctx, "/nonexistent/path", 1000, 1000)
	if err != nil {
		t.Fatalf("expected nil for nonexistent path, got: %v", err)
	}
}

func TestCleanupAppDataDirMissingPath(t *testing.T) {
	ctx := context.Background()
	err := CleanupAppDataDir(ctx, "/nonexistent/path", 1000, 1000)
	if err != nil {
		t.Fatalf("expected nil for nonexistent path, got: %v", err)
	}
}

func TestRunCustomAppSafelyHardensCompose(t *testing.T) {
	dir := t.TempDir()
	project := filepath.Join(dir, "project")
	if err := os.MkdirAll(project, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	composePath := filepath.Join(project, "docker-compose.yml")
	if err := os.WriteFile(composePath, []byte(`
services:
  app:
    image: alpine
`), 0o644); err != nil {
		t.Fatalf("write compose: %v", err)
	}

	stubDir := filepath.Join(dir, "bin")
	if err := os.MkdirAll(stubDir, 0o755); err != nil {
		t.Fatalf("mkdir stub: %v", err)
	}
	argsFile := filepath.Join(dir, "args.txt")
	stub := "#!/bin/sh\necho \"$@\" > " + argsFile + "\n"
	if err := os.WriteFile(filepath.Join(stubDir, "docker"), []byte(stub), 0o755); err != nil {
		t.Fatalf("write stub: %v", err)
	}
	t.Setenv("PATH", stubDir+string(os.PathListSeparator)+os.Getenv("PATH"))

	cm := NewComposeManager(nil)
	if err := cm.RunCustomAppSafely(context.Background(), project); err != nil {
		t.Fatalf("RunCustomAppSafely: %v", err)
	}

	data, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("read args: %v", err)
	}
	if !strings.Contains(string(data), "compose -f "+composePath+" up -d --remove-orphans") {
		t.Fatalf("unexpected docker args: %q", string(data))
	}

	raw, err := os.ReadFile(composePath)
	if err != nil {
		t.Fatalf("read hardened compose: %v", err)
	}
	var compose map[string]any
	if err := yaml.Unmarshal(raw, &compose); err != nil {
		t.Fatalf("unmarshal hardened compose: %v", err)
	}
	svc := compose["services"].(map[string]any)["app"].(map[string]any)
	if got := svc["cap_drop"]; got == nil || len(got.([]any)) == 0 || got.([]any)[0] != "ALL" {
		t.Fatalf("expected cap_drop ALL, got %#v", got)
	}
	if svc["read_only"] != true {
		t.Fatalf("expected read_only true, got %#v", svc["read_only"])
	}
	opts, ok := svc["security_opt"].([]any)
	if !ok || len(opts) == 0 {
		t.Fatalf("expected security_opt to include no-new-privileges, got %#v", svc["security_opt"])
	}
	found := false
	for _, v := range opts {
		if v == "no-new-privileges:true" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("no-new-privileges security opt missing: %#v", opts)
	}
}
