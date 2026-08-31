package network

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
)

func TestACMEJobLifecycle(t *testing.T) {
	db := setupTestDB(t)
	ctx := context.Background()

	for _, call := range []func() error{
		func() error { _, err := CreateACMEJob(ctx, nil, "example.test", "a@example.test", ""); return err },
		func() error { return UpdateACMEJobRunning(ctx, nil, "job") },
		func() error { return UpdateACMEJobFinished(ctx, nil, "job", true, "") },
		func() error { _, err := GetACMEJobByID(ctx, nil, "job"); return err },
		func() error { _, err := LatestACMEJobForDomain(ctx, nil, "example.test"); return err },
	} {
		if err := call(); err == nil {
			t.Fatal("nil database call returned no error")
		}
	}

	first, err := CreateACMEJob(ctx, db, "example.test", "admin@example.test", "route-1")
	if err != nil {
		t.Fatalf("create ACME job: %v", err)
	}
	if first.ID == "" || first.Status != ACMEJobQueued {
		t.Fatalf("unexpected created job: %+v", first)
	}
	if err := UpdateACMEJobRunning(ctx, db, first.ID); err != nil {
		t.Fatalf("mark running: %v", err)
	}
	running, err := GetACMEJobByID(ctx, db, first.ID)
	if err != nil {
		t.Fatalf("get running job: %v", err)
	}
	if running.Status != ACMEJobRunning || running.StartedAt == nil || running.RouteID != "route-1" {
		t.Fatalf("unexpected running job: %+v", running)
	}
	if err := UpdateACMEJobFinished(ctx, db, first.ID, false, "challenge failed"); err != nil {
		t.Fatalf("mark failed: %v", err)
	}
	failed, err := GetACMEJobByID(ctx, db, first.ID)
	if err != nil {
		t.Fatalf("get failed job: %v", err)
	}
	if failed.Status != ACMEJobFailed || failed.EndedAt == nil || failed.Error != "challenge failed" {
		t.Fatalf("unexpected failed job: %+v", failed)
	}

	time.Sleep(time.Millisecond)
	second, err := CreateACMEJob(ctx, db, "example.test", "admin@example.test", "")
	if err != nil {
		t.Fatalf("create second job: %v", err)
	}
	if err := UpdateACMEJobFinished(ctx, db, second.ID, true, ""); err != nil {
		t.Fatalf("mark succeeded: %v", err)
	}
	latest, err := LatestACMEJobForDomain(ctx, db, "example.test")
	if err != nil {
		t.Fatalf("latest ACME job: %v", err)
	}
	if latest.ID != second.ID || latest.Status != ACMEJobSucceeded || latest.RouteID != "" || latest.Error != "" {
		t.Fatalf("unexpected latest job: %+v", latest)
	}
	if _, err := GetACMEJobByID(ctx, db, "missing"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing job error = %v", err)
	}
	if _, err := LatestACMEJobForDomain(ctx, db, "missing.test"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("missing latest job error = %v", err)
	}
}

func TestACMEManagerCaddyIssuePaths(t *testing.T) {
	configPath := filepath.Join(t.TempDir(), "Caddyfile")
	if err := os.WriteFile(configPath, []byte("example.test { reverse_proxy localhost:8080 }\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	var loaded string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/config/":
			w.WriteHeader(http.StatusOK)
		case "/load":
			data := make([]byte, r.ContentLength)
			_, _ = r.Body.Read(data)
			loaded = string(data)
			w.WriteHeader(http.StatusOK)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)

	manager := NewACMEManager(server.URL, configPath)
	if manager.WithAuto(false) != manager || manager.WithExternal(ExternalACMEConfig{}) != manager || manager.WithMetrics(nil) != manager {
		t.Fatal("fluent ACME configuration did not return manager")
	}
	if manager.ExternalEnabled() {
		t.Fatal("external ACME unexpectedly enabled")
	}
	if err := manager.Issue(context.Background(), ACMERequest{Domain: "example.test", Email: "admin@example.test"}); err != nil {
		t.Fatalf("issue through Caddy API: %v", err)
	}
	if !strings.Contains(loaded, "reverse_proxy") {
		t.Fatalf("Caddyfile was not posted: %q", loaded)
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	manager.WithAuto(true)
	if err := manager.Issue(cancelled, ACMERequest{Domain: "example.test", Email: "admin@example.test"}); !errors.Is(err, context.Canceled) {
		t.Fatalf("auto issue cancellation = %v", err)
	}

	for _, tc := range []struct {
		name    string
		manager *ACMEManager
		request ACMERequest
	}{
		{"missing request fields", NewACMEManager(server.URL, configPath), ACMERequest{}},
		{"missing manager config", NewACMEManager("", ""), ACMERequest{Domain: "example.test", Email: "admin@example.test"}},
		{"missing caddyfile", NewACMEManager(server.URL, filepath.Join(t.TempDir(), "missing")), ACMERequest{Domain: "example.test", Email: "admin@example.test"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := tc.manager.Issue(context.Background(), tc.request); err == nil {
				t.Fatal("expected issuance error")
			}
		})
	}

	badHealth := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "unhealthy", http.StatusServiceUnavailable)
	}))
	t.Cleanup(badHealth.Close)
	if err := NewACMEManager(badHealth.URL, configPath).Issue(context.Background(), ACMERequest{Domain: "example.test", Email: "admin@example.test"}); err == nil {
		t.Fatal("unhealthy Caddy API was accepted")
	}

	badLoad := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/config/" {
			w.WriteHeader(http.StatusOK)
			return
		}
		http.Error(w, "bad config", http.StatusBadRequest)
	}))
	t.Cleanup(badLoad.Close)
	if err := NewACMEManager(badLoad.URL, configPath).Issue(context.Background(), ACMERequest{Domain: "example.test", Email: "admin@example.test"}); err == nil || !strings.Contains(err.Error(), "bad config") {
		t.Fatalf("bad Caddy load error = %v", err)
	}
}

func TestExternalACMEWithFakeLego(t *testing.T) {
	root := t.TempDir()
	dataPath := filepath.Join(root, "data")
	certsPath := filepath.Join(root, "certs")
	binPath := filepath.Join(root, "bin")
	if err := os.MkdirAll(binPath, 0o750); err != nil {
		t.Fatal(err)
	}
	legoScript := fmt.Sprintf(`#!/bin/sh
/bin/mkdir -p %[1]q/certificates
printf certificate > %[1]q/certificates/example.test.crt
printf key > %[1]q/certificates/example.test.key
printf wildcard-certificate > %[1]q/certificates/'*.example.test.crt'
printf wildcard-key > %[1]q/certificates/'*.example.test.key'
`, dataPath)
	if err := os.WriteFile(filepath.Join(binPath, "lego"), []byte(legoScript), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(binPath, "podman"), []byte("#!/bin/sh\nexit 0\n"), 0o750); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binPath+string(os.PathListSeparator)+os.Getenv("PATH"))

	external := ExternalACMEConfig{
		Enabled:        true,
		UsePodman:      false,
		ContainerImage: "fake-lego",
		DataPath:       dataPath,
		DNSProvider:    "cloudflare",
		DNSEnv:         map[string]string{"CLOUDFLARE_DNS_API_TOKEN": "token", "": "ignored"},
		Email:          "fallback@example.test",
		Staging:        true,
		CertsPath:      certsPath,
	}
	manager := NewACMEManager("", "").WithExternal(external)
	if !manager.ExternalEnabled() {
		t.Fatal("external ACME was not enabled")
	}
	if err := manager.Issue(context.Background(), ACMERequest{Domain: "example.test"}); err != nil {
		t.Fatalf("external certificate issue: %v", err)
	}
	for _, name := range []string{"fullchain.pem", "privkey.pem"} {
		if _, err := os.Stat(filepath.Join(certsPath, "example.test", name)); err != nil {
			t.Fatalf("missing copied %s: %v", name, err)
		}
	}

	manager.WithUsePodman(false)
	if manager.usePodmanOverride == nil || *manager.usePodmanOverride {
		t.Fatal("podman override was not stored")
	}
	if err := manager.RequestWildcardCert(context.Background(), "example.test", "fallback@example.test", &DNSProviderConfig{
		Provider: ProviderCloudflare,
		APIToken: "token",
	}); err != nil {
		t.Fatalf("wildcard certificate issue: %v", err)
	}
	for _, domainDir := range []string{"wildcard.example.test", "example.test"} {
		if _, err := os.Stat(filepath.Join(certsPath, domainDir, "fullchain.pem")); err != nil {
			t.Fatalf("missing wildcard copy for %s: %v", domainDir, err)
		}
	}
	manager.ClearUsePodmanOverride()
	if manager.usePodmanOverride != nil {
		t.Fatal("podman override was not cleared")
	}

	if err := manager.runLegoPodman(context.Background(), ExternalACMEConfig{
		DataPath: root, ContainerImage: "fake", DNSProvider: "cloudflare", KeyType: "rsa2048",
		DNSEnv: map[string]string{"TOKEN": "value", "": "ignored"}, Staging: true,
	}, []string{"example.test"}, "admin@example.test"); err != nil {
		t.Fatalf("fake podman lego run: %v", err)
	}
	if got := envMapToList(map[string]string{"A": "one", "": "skip"}); len(got) != 1 || got[0] != "A=one" {
		t.Fatalf("environment conversion = %#v", got)
	}

	copySource := filepath.Join(root, "source")
	copyDest := filepath.Join(root, "dest")
	if err := os.WriteFile(copySource, []byte("content"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := copyFile(copySource, copyDest, 0o640); err != nil {
		t.Fatalf("copy file: %v", err)
	}
	if data, err := os.ReadFile(copyDest); err != nil || string(data) != "content" {
		t.Fatalf("copied data = %q, %v", data, err)
	}
	if err := copyFile(filepath.Join(root, "missing"), copyDest, 0o600); err == nil {
		t.Fatal("copying a missing file succeeded")
	}
}

func TestExternalACMEValidationErrors(t *testing.T) {
	for _, tc := range []struct {
		name     string
		external ExternalACMEConfig
		request  ACMERequest
	}{
		{"empty domain", ExternalACMEConfig{Enabled: true}, ACMERequest{}},
		{"invalid domain", ExternalACMEConfig{Enabled: true}, ACMERequest{Domain: "bad domain", Email: "a@example.test"}},
		{"missing provider", ExternalACMEConfig{Enabled: true, CertsPath: t.TempDir()}, ACMERequest{Domain: "example.test", Email: "a@example.test"}},
		{"missing cert path", ExternalACMEConfig{Enabled: true, DNSProvider: "cloudflare"}, ACMERequest{Domain: "example.test", Email: "a@example.test"}},
		{"missing email", ExternalACMEConfig{Enabled: true, DNSProvider: "cloudflare", CertsPath: t.TempDir()}, ACMERequest{Domain: "example.test"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := NewACMEManager("", "").WithExternal(tc.external).Issue(context.Background(), tc.request); err == nil {
				t.Fatal("expected external issuance validation error")
			}
		})
	}

	manager := NewACMEManager("", "").WithExternal(ExternalACMEConfig{})
	if err := manager.RequestWildcardCert(context.Background(), "bad domain", "a@example.test", &DNSProviderConfig{Provider: ProviderCloudflare}); err == nil {
		t.Fatal("invalid wildcard domain was accepted")
	}
	if err := manager.RequestWildcardCert(context.Background(), "example.test", "a@example.test", &DNSProviderConfig{Provider: ProviderType("unsupported")}); err == nil {
		t.Fatal("unsupported wildcard DNS provider was accepted")
	}
	if err := manager.RequestWildcardCert(context.Background(), "example.test", "", &DNSProviderConfig{Provider: ProviderCloudflare}); err == nil {
		t.Fatal("missing wildcard email was accepted")
	}
}

func TestCaddyPublicAccessorsAndMigrateRoutes(t *testing.T) {
	manager, _ := setupTestCaddyManager(t, "noop")
	if err := manager.Initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	manager.WithMetrics((*monitoring.CaddyMetrics)(nil))
	if manager.AdminEndpoint() != "" || manager.ConfigPath() == "" || manager.Config().DefaultDomain != "test.local" {
		t.Fatalf("unexpected Caddy accessors: endpoint=%q path=%q config=%+v", manager.AdminEndpoint(), manager.ConfigPath(), manager.Config())
	}

	if _, err := manager.AddRoute(context.Background(), "first", "test.local", "http://localhost:8081", "app-1"); err != nil {
		t.Fatal(err)
	}
	if _, err := manager.AddRoute(context.Background(), "second", "custom.test", "http://localhost:8082", "app-2"); err != nil {
		t.Fatal(err)
	}
	routes := manager.ListRoutes()
	if len(routes) != 2 {
		t.Fatalf("listed routes = %d", len(routes))
	}
	if count, err := manager.MigrateRoutes("", "new.test"); err != nil || count != 0 {
		t.Fatalf("empty migration = %d, %v", count, err)
	}
	count, err := manager.MigrateRoutes("test.local", "new.test")
	if err != nil || count != 1 {
		t.Fatalf("migrate routes = %d, %v", count, err)
	}
	if _, ok := manager.FindRouteByDomain("first.new.test"); !ok {
		t.Fatal("migrated route not found under new domain")
	}
	if _, ok := manager.FindRouteByDomain("second.custom.test"); !ok {
		t.Fatal("custom route changed during migration")
	}
}

func TestValidationAndNetworkErrorHelpers(t *testing.T) {
	validDomains := []string{"example.test", "*.example.test", "localhost"}
	for _, domain := range validDomains {
		if err := ValidateDomain(domain); err != nil {
			t.Errorf("ValidateDomain(%q): %v", domain, err)
		}
	}
	invalidDomains := []string{"", ".example.test", "example..test", "foo.*.test", "-bad.test", strings.Repeat("a", 64) + ".test", strings.Repeat("a", 254)}
	for _, domain := range invalidDomains {
		if err := ValidateDomain(domain); err == nil {
			t.Errorf("ValidateDomain(%q) succeeded", domain)
		}
	}
	for _, subdomain := range []string{"", "app", "app-1"} {
		if err := ValidateSubdomain(subdomain); err != nil {
			t.Errorf("ValidateSubdomain(%q): %v", subdomain, err)
		}
	}
	for _, subdomain := range []string{"bad.name", "-bad", strings.Repeat("a", 64)} {
		if err := ValidateSubdomain(subdomain); err == nil {
			t.Errorf("ValidateSubdomain(%q) succeeded", subdomain)
		}
	}
	for _, backend := range []string{"http://localhost:8080", "https://example.test", "http://[::1]:8080", "unix:///tmp/app.sock"} {
		if err := ValidateBackend(backend); err != nil {
			t.Errorf("ValidateBackend(%q): %v", backend, err)
		}
	}
	for _, backend := range []string{"", "localhost", "localhost:8080", "[::1]:8080", "ftp://example.test/file", "http://bad host", "unix:///tmp/bad path.sock"} {
		if err := ValidateBackend(backend); err == nil {
			t.Errorf("ValidateBackend(%q) succeeded", backend)
		}
	}

	inner := errors.New("inner")
	caddyErr := &CaddyError{Op: "test", Err: inner, Context: "details"}
	if !strings.Contains(caddyErr.Error(), "test") || !strings.Contains(caddyErr.Error(), "details") || !errors.Is(caddyErr, inner) {
		t.Fatalf("Caddy error wrapping failed: %v", caddyErr)
	}
}
