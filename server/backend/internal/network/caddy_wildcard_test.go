package network

import (
	"os"
	"path/filepath"
	"testing"
)

func TestManualTLSPathsWildcardFallback(t *testing.T) {
	tmpDir := t.TempDir()
	certsDir := filepath.Join(tmpDir, "certs")
	if err := os.MkdirAll(certsDir, 0o755); err != nil {
		t.Fatal(err)
	}

	writeCert := func(domain string) {
		dir := filepath.Join(certsDir, safeDomainDir(domain))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "fullchain.pem"), []byte("cert-"+domain), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "privkey.pem"), []byte("key-"+domain), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	writeCert("example.com")
	writeCert("*.example.com")

	cm := &CaddyManager{
		config: CaddyConfig{CertsPath: certsDir},
	}

	cert, key, ok := cm.manualTLSPaths("example.com")
	if !ok {
		t.Fatal("expected exact match for example.com")
	}
	if cert == "" || key == "" {
		t.Error("expected cert and key paths")
	}

	cert, _, ok = cm.manualTLSPaths("app.example.com")
	if !ok {
		t.Fatal("expected wildcard fallback for app.example.com")
	}
	wantDir := safeDomainDir("*.example.com")
	if dir := filepath.Base(filepath.Dir(cert)); dir != wantDir {
		t.Errorf("cert dir = %q, want %q", dir, wantDir)
	}

	_, _, ok = cm.manualTLSPaths("other.example.com")
	if !ok {
		t.Fatal("expected wildcard fallback for other.example.com")
	}

	_, _, ok = cm.manualTLSPaths("unrelated.net")
	if ok {
		t.Error("expected no match for unrelated domain")
	}
}

func TestCertPathsForDomain(t *testing.T) {
	tmpDir := t.TempDir()
	certsDir := filepath.Join(tmpDir, "certs")
	dir := filepath.Join(certsDir, safeDomainDir("example.com"))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "fullchain.pem"), []byte("cert-data"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "privkey.pem"), []byte("key-data"), 0o600); err != nil {
		t.Fatal(err)
	}

	cm := &CaddyManager{config: CaddyConfig{CertsPath: certsDir}}

	_, _, ok := cm.certPathsForDomain("example.com")
	if !ok {
		t.Error("expected certPathsForDomain to find example.com")
	}

	_, _, ok = cm.certPathsForDomain("*.example.com")
	if ok {
		t.Error("expected certPathsForDomain to NOT find wildcard cert without wildcard prefix")
	}
}

func TestWildcardBlocksLocked(t *testing.T) {
	tmpDir := t.TempDir()
	certsDir := filepath.Join(tmpDir, "certs")

	writeCert := func(domain string) {
		dir := filepath.Join(certsDir, safeDomainDir(domain))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "fullchain.pem"), []byte("cert"), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "privkey.pem"), []byte("key"), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	writeCert("*.example.com")
	writeCert("*.other.net")

	cm := &CaddyManager{config: CaddyConfig{CertsPath: certsDir}}

	blocks := cm.wildcardBlocksLocked()
	if len(blocks) != 2 {
		t.Fatalf("expected 2 wildcard blocks, got %d", len(blocks))
	}
	if blocks[0].Domain != "example.com" {
		t.Errorf("first block domain = %q, want example.com", blocks[0].Domain)
	}
	if blocks[1].Domain != "other.net" {
		t.Errorf("second block domain = %q, want other.net", blocks[1].Domain)
	}
}

func TestBaseDomain(t *testing.T) {
	tests := []struct {
		input string
		want  string
	}{
		{"app.example.com", "example.com"},
		{"*.example.com", "example.com"},
		{"a.b.c.example.com", "b.c.example.com"},
		{"example.com", ""},
		{"com", ""},
		{"", ""},
	}
	for _, tt := range tests {
		got := baseDomain(tt.input)
		if got != tt.want {
			t.Errorf("baseDomain(%q) = %q, want %q", tt.input, got, tt.want)
		}
	}
}

func TestSafeDomainDir(t *testing.T) {
	tests := []struct {
		domain string
		want   string
	}{
		{"example.com", "example.com"},
		{"*.example.com", "wildcard.example.com"},
		{"App.Example.COM", "app.example.com"},
		{"", "_"},
	}
	for _, tt := range tests {
		got := safeDomainDir(tt.domain)
		if got != tt.want {
			t.Errorf("safeDomainDir(%q) = %q, want %q", tt.domain, got, tt.want)
		}
	}
}
