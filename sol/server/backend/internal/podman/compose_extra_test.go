package podman

import (
	"context"
	"os"
	"path/filepath"
	"testing"
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
