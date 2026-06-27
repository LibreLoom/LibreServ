package network

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobqueue"
)

func TestRevocationHandler_Process_NoHardError(t *testing.T) {
	cm, tmpDir := setupTestCaddyManager(t, "noop")
	cm.config.CertsPath = filepath.Join(tmpDir, "certs")

	// Create pretend certificate files for the domain.
	domain := "app.example.com"
	certDir := filepath.Join(cm.config.CertsPath, safeDomainDir(domain))
	if err := os.MkdirAll(certDir, 0o750); err != nil {
		t.Fatalf("create cert dir: %v", err)
	}
	certFile := filepath.Join(certDir, "fullchain.pem")
	keyFile := filepath.Join(certDir, "privkey.pem")
	if err := os.WriteFile(certFile, []byte("cert"), 0o644); err != nil {
		t.Fatalf("write cert: %v", err)
	}
	if err := os.WriteFile(keyFile, []byte("key"), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}

	acmeManager := NewACMEManager("", "")
	handler := NewRevocationHandler(acmeManager, cm)

	job := &jobqueue.Job{
		ID:      "job-1",
		Type:    jobqueue.JobTypeRevocation,
		Domain:  domain,
		RouteID: "route-1",
	}

	if err := handler.Process(context.Background(), job, cm.db); err != nil {
		t.Fatalf("Process returned error: %v", err)
	}

	if _, err := os.Stat(certFile); !os.IsNotExist(err) {
		t.Errorf("cert file was not removed: %s", certFile)
	}
	if _, err := os.Stat(keyFile); !os.IsNotExist(err) {
		t.Errorf("key file was not removed: %s", keyFile)
	}
}

func TestRevocationHandler_Process_NoCaddyManager(t *testing.T) {
	acmeManager := NewACMEManager("", "")
	handler := NewRevocationHandler(acmeManager, nil)

	job := &jobqueue.Job{
		ID:     "job-2",
		Type:   jobqueue.JobTypeRevocation,
		Domain: "app.example.com",
	}

	if err := handler.Process(context.Background(), job, nil); err != nil {
		t.Fatalf("Process returned error: %v", err)
	}
}

func TestRevocationHandler_Process_EmptyDomain(t *testing.T) {
	cm, _ := setupTestCaddyManager(t, "noop")
	acmeManager := NewACMEManager("", "")
	handler := NewRevocationHandler(acmeManager, cm)

	job := &jobqueue.Job{
		ID:   "job-3",
		Type: jobqueue.JobTypeRevocation,
	}

	if err := handler.Process(context.Background(), job, cm.db); err != nil {
		t.Fatalf("Process returned error for empty domain: %v", err)
	}
}

func TestRevocationHandler_Process_RemovesWildcardCert(t *testing.T) {
	cm, tmpDir := setupTestCaddyManager(t, "noop")
	cm.config.CertsPath = filepath.Join(tmpDir, "certs")

	domain := "app.example.com"
	// certDirForDomain encodes the same wildcard naming Caddy uses, so this
	// test also verifies deleteLocalCerts matches the real cert storage path.
	wildcardDir := cm.certDirForDomain("*." + strings.SplitN(domain, ".", 2)[1])
	if err := os.MkdirAll(wildcardDir, 0o750); err != nil {
		t.Fatalf("create wildcard cert dir: %v", err)
	}
	certFile := filepath.Join(wildcardDir, "fullchain.pem")
	keyFile := filepath.Join(wildcardDir, "privkey.pem")
	if err := os.WriteFile(certFile, []byte("wildcard-cert"), 0o644); err != nil {
		t.Fatalf("write cert: %v", err)
	}
	if err := os.WriteFile(keyFile, []byte("wildcard-key"), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}

	acmeManager := NewACMEManager("", "")
	handler := NewRevocationHandler(acmeManager, cm)

	job := &jobqueue.Job{
		ID:      "job-4",
		Type:    jobqueue.JobTypeRevocation,
		Domain:  domain,
		RouteID: "route-4",
	}

	if err := handler.Process(context.Background(), job, cm.db); err != nil {
		t.Fatalf("Process returned error: %v", err)
	}

	if _, err := os.Stat(certFile); !os.IsNotExist(err) {
		t.Errorf("wildcard cert file was not removed: %s", certFile)
	}
	if _, err := os.Stat(keyFile); !os.IsNotExist(err) {
		t.Errorf("wildcard key file was not removed: %s", keyFile)
	}
}

func TestRevocationHandler_Process_ApplyConfigErrorStillSucceeds(t *testing.T) {
	cm, tmpDir := setupTestCaddyManager(t, "noop")
	cm.config.CertsPath = filepath.Join(tmpDir, "certs")
	// Make ConfigPath point to an existing directory so WriteFile fails,
	// guaranteeing ApplyConfig returns an error. Process must still succeed.
	cm.config.ConfigPath = tmpDir

	acmeManager := NewACMEManager("", "")
	handler := NewRevocationHandler(acmeManager, cm)

	job := &jobqueue.Job{
		ID:     "job-5",
		Type:   jobqueue.JobTypeRevocation,
		Domain: "app.example.com",
	}

	if err := handler.Process(context.Background(), job, cm.db); err != nil {
		t.Fatalf("Process returned error despite ApplyConfig failure: %v", err)
	}
}

func TestRevocationHandler_Type(t *testing.T) {
	handler := NewRevocationHandler(nil, nil)
	if got := handler.Type(); got != jobqueue.JobTypeRevocation {
		t.Errorf("Type() = %v, want %v", got, jobqueue.JobTypeRevocation)
	}
}

func TestRevocationHandler_MaxRetries(t *testing.T) {
	handler := NewRevocationHandler(nil, nil)
	if got := handler.MaxRetries(); got != jobqueue.DefaultMaxRetriesRevocation {
		t.Errorf("MaxRetries() = %v, want %v", got, jobqueue.DefaultMaxRetriesRevocation)
	}
}
