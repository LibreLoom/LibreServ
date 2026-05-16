package support

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPathPolicyAllowDeny(t *testing.T) {
	p := NewDefaultPolicy([]string{})
	p.Deny = append(p.Deny, "/denythis")
	p.Allow = append(p.Allow, "/tmp")

	allowed, err := p.IsAllowed("/tmp/file.txt")
	if err != nil {
		t.Fatalf("allow check: %v", err)
	}
	if !allowed {
		t.Fatalf("expected allowed path")
	}

	denied, err := p.IsAllowed("/denythis/secret")
	if err != nil {
		t.Fatalf("deny check: %v", err)
	}
	if denied {
		t.Fatalf("expected deny")
	}
}

func TestPathPolicyConfigFileDenied(t *testing.T) {
	p := NewDefaultPolicy([]string{})

	// /etc/libreserv is allowed, but libreserv.yaml (which contains secrets) should be denied
	allowed, err := p.IsAllowed("/etc/libreserv/app-configs/myapp.yaml")
	if err != nil {
		t.Fatalf("app-config check: %v", err)
	}
	if !allowed {
		t.Fatalf("expected /etc/libreserv/app-configs to be allowed")
	}

	denied, err := p.IsAllowed("/etc/libreserv/libreserv.yaml")
	if err != nil {
		t.Fatalf("config deny check: %v", err)
	}
	if denied {
		t.Fatalf("expected /etc/libreserv/libreserv.yaml to be denied (contains secrets)")
	}
}

func TestPathPolicySymlink(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte("x"), 0o600); err != nil {
		t.Fatalf("write target: %v", err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatalf("symlink: %v", err)
	}

	p := &PathPolicy{
		Allow: []string{dir},
		Deny:  []string{},
	}
	allowed, err := p.IsAllowed(link)
	if err != nil {
		t.Fatalf("symlink check: %v", err)
	}
	if !allowed {
		t.Fatalf("expected symlink allowed within allow root")
	}
}
