package apps

import (
	"os"
	"path/filepath"
	"testing"
)

func writeCatalogApp(t *testing.T, dir, id, yaml string) {
	t.Helper()
	appDir := filepath.Join(dir, "apps", id)
	if err := os.MkdirAll(appDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(appDir, "app.yaml"), []byte(yaml), 0o644); err != nil {
		t.Fatalf("write app.yaml: %v", err)
	}
}

func TestAccessSchemaParse(t *testing.T) {
	dir := t.TempDir()

	// Web-only app (no access declared → defaults to web-only)
	writeCatalogApp(t, dir, "webapp", `id: webapp
name: Web App
description: Test
version: "1"
category: other
deployment:
  compose_file: docker-compose.yml
`)

	// Ports app, Minecraft-style (tcp+udp 25565, no web)
	writeCatalogApp(t, dir, "mc", `id: mc
name: Minecraft
description: Test
version: "1"
category: games
access:
  web: false
  ports:
    - protocol: tcp
      port: 25565
      verify_hint: bedrock_ping
    - protocol: udp
      port: 25565
deployment:
  image: itzg/minecraft-server
`)

	// Large-uploads web app, Nextcloud-style
	writeCatalogApp(t, dir, "nc", `id: nc
name: Nextcloud
description: Test
version: "1"
category: productivity
access:
  web: true
  large_uploads: true
deployment:
  compose_file: docker-compose.yml
`)

	c, err := NewCatalog(dir)
	if err != nil {
		t.Fatalf("NewCatalog: %v", err)
	}

	t.Run("web-only defaults to web access", func(t *testing.T) {
		app, err := c.GetApp("webapp")
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		acc := app.ResolveAccess()
		if !acc.Web || len(acc.Ports) != 0 || acc.LargeUploads {
			t.Errorf("ResolveAccess() = %+v, want web-only default", acc)
		}
	})

	t.Run("ports app parses tcp+udp with verify hint", func(t *testing.T) {
		app, err := c.GetApp("mc")
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		acc := app.Access
		if acc.Web {
			t.Error("Web = true, want false")
		}
		if len(acc.Ports) != 2 {
			t.Fatalf("len(Ports) = %d, want 2", len(acc.Ports))
		}
		if acc.Ports[0].Protocol != "tcp" || acc.Ports[0].Port != 25565 || acc.Ports[0].VerifyHint != "bedrock_ping" {
			t.Errorf("Ports[0] = %+v, want tcp/25565/bedrock_ping", acc.Ports[0])
		}
		if acc.Ports[1].Protocol != "udp" || acc.Ports[1].Port != 25565 {
			t.Errorf("Ports[1] = %+v, want udp/25565", acc.Ports[1])
		}
	})

	t.Run("large_uploads app parses flag", func(t *testing.T) {
		app, err := c.GetApp("nc")
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		if !app.Access.Web || !app.Access.LargeUploads {
			t.Errorf("Access = %+v, want web + large_uploads", app.Access)
		}
	})

	t.Run("clone deep-copies ports", func(t *testing.T) {
		app, err := c.GetApp("mc")
		if err != nil {
			t.Fatalf("Get: %v", err)
		}
		cl := app.Clone()
		cl.Access.Ports[0].Port = 9999
		if app.Access.Ports[0].Port != 25565 {
			t.Error("Clone() mutated original Access.Ports")
		}
	})
}
