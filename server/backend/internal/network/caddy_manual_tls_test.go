package network

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func TestCaddyfileUsesManualTLSWhenCertExists(t *testing.T) {
	t.Parallel()

	tmpDB := filepath.Join(t.TempDir(), "test.db")
	db, err := database.Open(tmpDB)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })

	configPath := filepath.Join(t.TempDir(), "Caddyfile")
	certsPath := filepath.Join(t.TempDir(), "certs")
	domain := "example.com"

	// Create cert files in the expected layout.
	domainDir := filepath.Join(certsPath, safeDomainDir(domain))
	if err := os.MkdirAll(domainDir, 0o755); err != nil {
		t.Fatal(err)
	}
	certFile := filepath.Join(domainDir, "fullchain.pem")
	keyFile := filepath.Join(domainDir, "privkey.pem")
	if err := os.WriteFile(certFile, []byte("dummy-cert"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyFile, []byte("dummy-key"), 0o600); err != nil {
		t.Fatal(err)
	}

	cm := NewCaddyManager(db, CaddyConfig{
		Mode:       "noop",
		ConfigPath: configPath,
		CertsPath:  certsPath,
		AutoHTTPS:  false,
	})
	if err := cm.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, err := cm.AddDomainRoute(context.Background(), domain, "http://127.0.0.1:8080", "test"); err != nil {
		t.Fatal(err)
	}

	content, err := cm.GetCaddyfileContent()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(content, "tls "+certFile+" "+keyFile) {
		t.Fatalf("expected manual tls directive using cert/key paths; got:\n%s", content)
	}
}
