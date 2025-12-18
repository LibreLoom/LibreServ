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

	// Stub docker binary to avoid real docker calls.
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

	// Verify docker stub was invoked with compose args.
	data, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatalf("read args: %v", err)
	}
	if !strings.Contains(string(data), "compose -f "+composePath+" up -d --remove-orphans") {
		t.Fatalf("unexpected docker args: %q", string(data))
	}

	// Ensure hardened fields were applied.
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
