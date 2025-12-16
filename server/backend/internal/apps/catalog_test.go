package apps

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCatalogLoadAndGet(t *testing.T) {
	dir := t.TempDir()
	// create a minimal app definition
	appDir := filepath.Join(dir, "builtin", "demo")
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	yaml := `id: demo
name: Demo App
description: Test app
version: "1"
category: other
deployment:
  compose_file: docker-compose.yml
`
	if err := os.WriteFile(filepath.Join(appDir, "app.yaml"), []byte(yaml), 0o644); err != nil {
		t.Fatalf("write app.yaml: %v", err)
	}

	c, err := NewCatalog(dir)
	if err != nil {
		t.Fatalf("NewCatalog: %v", err)
	}

	if c.Count() != 1 {
		t.Fatalf("expected 1 app, got %d", c.Count())
	}

	app, err := c.GetApp("demo")
	if err != nil {
		t.Fatalf("GetApp: %v", err)
	}
	if app.Name != "Demo App" {
		t.Fatalf("unexpected name %s", app.Name)
	}

	// refresh should still work
	if err := c.Refresh(); err != nil {
		t.Fatalf("Refresh: %v", err)
	}
}
