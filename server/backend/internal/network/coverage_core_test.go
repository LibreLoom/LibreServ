package network

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobqueue"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
)

func TestACMEJobLifecycleCoverage(t *testing.T) {
	cm, _ := setupTestCaddyManager(t, "noop")
	ctx := context.Background()

	if _, err := CreateACMEJob(ctx, nil, "x.example.test", "a@example.test", ""); err == nil {
		t.Fatal("nil database should fail")
	}
	job, err := CreateACMEJob(ctx, cm.db, "x.example.test", "a@example.test", "route-one")
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != ACMEJobQueued || job.RouteID != "route-one" {
		t.Fatalf("unexpected new job: %+v", job)
	}
	if err := UpdateACMEJobRunning(ctx, nil, job.ID); err == nil {
		t.Fatal("nil database running update should fail")
	}
	if err := UpdateACMEJobRunning(ctx, cm.db, job.ID); err != nil {
		t.Fatal(err)
	}
	got, err := GetACMEJobByID(ctx, cm.db, job.ID)
	if err != nil || got.Status != ACMEJobRunning || got.StartedAt == nil {
		t.Fatalf("running job: %+v err=%v", got, err)
	}
	if err := UpdateACMEJobFinished(ctx, cm.db, job.ID, false, "failed on purpose"); err != nil {
		t.Fatal(err)
	}
	got, err = LatestACMEJobForDomain(ctx, cm.db, job.Domain)
	if err != nil || got.Status != ACMEJobFailed || got.Error != "failed on purpose" || got.EndedAt == nil {
		t.Fatalf("finished job: %+v err=%v", got, err)
	}
	if err := UpdateACMEJobFinished(ctx, cm.db, job.ID, true, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := GetACMEJobByID(ctx, nil, job.ID); err == nil {
		t.Fatal("nil database get should fail")
	}
	if _, err := LatestACMEJobForDomain(ctx, nil, job.Domain); err == nil {
		t.Fatal("nil database latest should fail")
	}
}

func writeFakeLego(t *testing.T) string {
	t.Helper()
	binDir := t.TempDir()
	script := `#!/bin/sh
path=""
first=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --path) path="$2"; shift 2 ;;
    -d) if [ -z "$first" ]; then first="$2"; fi; shift 2 ;;
    *) shift ;;
  esac
done
/bin/mkdir -p "$path/certificates"
/usr/bin/printf cert > "$path/certificates/$first.crt"
/usr/bin/printf key > "$path/certificates/$first.key"
`
	lego := filepath.Join(binDir, "lego")
	if err := os.WriteFile(lego, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", binDir)
	return binDir
}

func TestACMEManagerAutomaticAndExternalCoverage(t *testing.T) {
	configFile := filepath.Join(t.TempDir(), "Caddyfile")
	if err := os.WriteFile(configFile, []byte("example.test {}"), 0o600); err != nil {
		t.Fatal(err)
	}
	loadStatus := http.StatusOK
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/config/":
			w.WriteHeader(http.StatusOK)
		case "/load":
			w.WriteHeader(loadStatus)
			_, _ = w.Write([]byte("load response"))
		case "/certificates":
			_, _ = w.Write([]byte(`[{"names":["app.example.test"]}]`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	manager := NewACMEManager(server.URL, configFile)
	if manager.WithAuto(false) != manager || manager.WithMetrics(monitoring.NewCaddyMetrics()) != manager {
		t.Fatal("fluent ACME configuration should return receiver")
	}
	if manager.ExternalEnabled() {
		t.Fatal("external issuance should start disabled")
	}
	if err := manager.Issue(context.Background(), ACMERequest{}); err == nil {
		t.Fatal("missing request fields should fail")
	}
	if err := manager.Issue(context.Background(), ACMERequest{Domain: "app.example.test", Email: "a@example.test"}); err != nil {
		t.Fatalf("automatic issue: %v", err)
	}
	loadStatus = http.StatusBadRequest
	if err := manager.Issue(context.Background(), ACMERequest{Domain: "app.example.test", Email: "a@example.test"}); err == nil {
		t.Fatal("failed load should surface")
	}
	loadStatus = http.StatusOK

	missing := NewACMEManager("", "")
	if err := missing.Issue(context.Background(), ACMERequest{Domain: "app.example.test", Email: "a@example.test"}); err == nil {
		t.Fatal("missing automatic configuration should fail")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	manager.WithAuto(true)
	if err := manager.pollIssued(cancelled, "app.example.test"); err == nil {
		t.Fatal("cancelled poll should fail")
	}

	writeFakeLego(t)
	dataDir := filepath.Join(t.TempDir(), "lego-data")
	certsDir := filepath.Join(t.TempDir(), "certs")
	external := NewACMEManager("", "").WithExternal(ExternalACMEConfig{
		Enabled:     true,
		UsePodman:   false,
		DataPath:    dataDir,
		DNSProvider: "cloudflare",
		DNSEnv:      map[string]string{"TOKEN": "secret", "": "ignored"},
		Email:       "default@example.test",
		CertsPath:   certsDir,
	})
	if !external.ExternalEnabled() {
		t.Fatal("external issuance should be enabled")
	}
	if err := external.Issue(context.Background(), ACMERequest{Domain: "app.example.test"}); err != nil {
		t.Fatalf("external issue: %v", err)
	}
	if _, err := os.Stat(filepath.Join(certsDir, safeDomainDir("app.example.test"), "fullchain.pem")); err != nil {
		t.Fatalf("external certificate missing: %v", err)
	}
	if err := external.Issue(context.Background(), ACMERequest{}); err == nil {
		t.Fatal("external missing domain should fail")
	}

	external.WithUsePodman(false)
	if err := external.RequestWildcardCert(context.Background(), "wild.example.test", "", &DNSProviderConfig{
		Provider: ProviderCloudflare,
		APIToken: "token",
	}); err != nil {
		t.Fatalf("wildcard issue: %v", err)
	}
	external.ClearUsePodmanOverride()
	for _, domain := range []string{"*.wild.example.test", "wild.example.test"} {
		if _, err := os.Stat(filepath.Join(certsDir, safeDomainDir(domain), "privkey.pem")); err != nil {
			t.Fatalf("wildcard key for %s missing: %v", domain, err)
		}
	}
	if err := external.RequestWildcardCert(context.Background(), "invalid", "", &DNSProviderConfig{Provider: ProviderCloudflare}); err == nil {
		t.Fatal("invalid wildcard domain should fail")
	}
	if got := envMapToList(map[string]string{"A": "one", "": "skip"}); len(got) != 1 || got[0] != "A=one" {
		t.Fatalf("environment conversion: %v", got)
	}
	src := filepath.Join(t.TempDir(), "source")
	dst := filepath.Join(t.TempDir(), "destination")
	if err := os.WriteFile(src, []byte("copied"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := copyFile(src, dst, 0o640); err != nil {
		t.Fatal(err)
	}
}

type renewalCoverageQueue struct {
	running   bool
	latest    jobqueue.JobInfo
	latestErr error
	enqueued  []*jobqueue.Job
}

func (q *renewalCoverageQueue) Enqueue(kind jobqueue.JobType, domain, email, routeID string, priority jobqueue.JobPriority) (jobqueue.JobInfo, error) {
	job := &jobqueue.Job{
		ID: "renewal-job", Type: kind, Domain: domain, Email: email, RouteID: routeID,
		Status: jobqueue.JobStatusQueued, Priority: priority,
	}
	q.enqueued = append(q.enqueued, job)
	return job, nil
}
func (q *renewalCoverageQueue) GetLatestJob(context.Context, string, jobqueue.JobType) (jobqueue.JobInfo, error) {
	return q.latest, q.latestErr
}
func (q *renewalCoverageQueue) IsRunning() bool { return q.running }

func TestRenewalSchedulerCoverage(t *testing.T) {
	defaults := DefaultRenewalSchedulerConfig()
	if !defaults.Enabled || defaults.Interval <= 0 || defaults.RenewalThreshold <= 0 {
		t.Fatalf("bad defaults: %+v", defaults)
	}
	disabled := NewRenewalScheduler(nil, nil, RenewalSchedulerConfig{Enabled: false})
	disabled.Start()
	disabled.Stop()

	noCaddy := NewRenewalScheduler(&renewalCoverageQueue{running: true}, nil, defaults)
	noCaddy.checkAndRenew()

	cm, _ := setupTestCaddyManager(t, "noop")
	notRunning := NewRenewalScheduler(&renewalCoverageQueue{}, cm, defaults)
	notRunning.checkAndRenew()

	expiry := time.Now().Add(48 * time.Hour)
	certStatus := http.StatusOK
	certBody := func() string {
		return fmt.Sprintf(`[{"names":["renew.example.test"],"not_after":%q,"issuer":"test-ca"}]`, expiry.Format(time.RFC3339Nano))
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(certStatus)
		_, _ = w.Write([]byte(certBody()))
	}))
	defer server.Close()
	cm.config.AdminAPI = server.URL
	cm.config.Email = ""
	route, err := cm.AddRoute(context.Background(), "renew", "example.test", "http://127.0.0.1:8080", "app")
	if err != nil {
		t.Fatal(err)
	}
	cm.routesMu.Lock()
	route.SSL = true
	cm.routes[route.ID] = route
	cm.routesMu.Unlock()

	queue := &renewalCoverageQueue{running: true, latestErr: fmt.Errorf("not found")}
	scheduler := NewRenewalScheduler(queue, cm, RenewalSchedulerConfig{
		Enabled: true, Interval: time.Millisecond, RenewalThreshold: 30 * 24 * time.Hour,
	})
	info, err := scheduler.getCertificateInfo(context.Background(), "renew.example.test")
	if err != nil || info == nil || info.Domain != "renew.example.test" {
		t.Fatalf("certificate info: %+v err=%v", info, err)
	}
	scheduler.checkAndRenew()
	if len(queue.enqueued) != 1 || queue.enqueued[0].Email != "admin@example.test" {
		t.Fatalf("renewal not queued: %+v", queue.enqueued)
	}

	queue.latest = &jobqueue.Job{ID: "existing", Status: jobqueue.JobStatusRunning}
	queue.latestErr = nil
	scheduler.checkAndRenew()
	if len(queue.enqueued) != 1 {
		t.Fatal("pending renewal should prevent duplicate")
	}

	if info, err := scheduler.getCertificateInfo(context.Background(), "missing.example.test"); err != nil || info != nil {
		t.Fatalf("missing certificate: %+v err=%v", info, err)
	}
	certStatus = http.StatusInternalServerError
	if _, err := scheduler.getCertificateInfo(context.Background(), "renew.example.test"); err == nil {
		t.Fatal("bad certificate endpoint status should fail")
	}
	certStatus = http.StatusOK

	scheduler.Start()
	time.Sleep(3 * time.Millisecond)
	scheduler.Stop()
}

func TestCertificateJobHandlersCoverage(t *testing.T) {
	issuance := NewIssuanceHandler(nil, nil)
	renewal := NewRenewalHandler(nil, nil)
	validation := NewValidationHandler()
	if issuance.Type() != jobqueue.JobTypeIssuance || issuance.MaxRetries() <= 0 {
		t.Fatal("issuance metadata")
	}
	if renewal.Type() != jobqueue.JobTypeRenewal || renewal.MaxRetries() <= 0 {
		t.Fatal("renewal metadata")
	}
	if validation.Type() != jobqueue.JobTypeValidation || validation.MaxRetries() <= 0 {
		t.Fatal("validation metadata")
	}
	job := &jobqueue.Job{ID: "job", Domain: "localhost", Email: "a@example.test"}
	if err := issuance.Process(context.Background(), job, nil); err == nil {
		t.Fatal("nil issuance manager should fail")
	}
	if err := renewal.Process(context.Background(), job, nil); err == nil {
		t.Fatal("nil renewal manager should fail")
	}

	manager := NewACMEManager("", "")
	issuance = NewIssuanceHandler(manager, nil)
	renewal = NewRenewalHandler(manager, nil)
	if err := issuance.Process(context.Background(), job, nil); err == nil {
		t.Fatal("unconfigured issuance should fail")
	}
	if err := renewal.Process(context.Background(), job, nil); err == nil {
		t.Fatal("unconfigured renewal should fail")
	}
	if err := validation.Process(context.Background(), job, nil); err == nil {
		if len(job.Logs) == 0 {
			t.Fatal("validation should record logs")
		}
	}
}

func writeLongRunningBinary(t *testing.T, dir, name string) {
	t.Helper()
	script := "#!/bin/sh\ntrap 'exit 0' INT TERM\nwhile :; do /bin/sleep 1; done\n"
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

func TestTunnelProviderLifecycleCoverage(t *testing.T) {
	binDir := t.TempDir()
	writeLongRunningBinary(t, binDir, "frpc")
	frp := newFRPProvider(FRPConfig{
		TunnelProviderConfig: TunnelProviderConfig{Token: "token", Enabled: true},
		Server:               "relay.example.test:7000",
	}, binDir, slogTestLogger())
	if !frp.IsInstalled() || frp.Install(context.Background()) != nil {
		t.Fatal("preinstalled frpc should be accepted")
	}
	if err := frp.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if !frp.Status().Enabled || !frp.processAlive() {
		t.Fatal("frpc should be running")
	}
	if err := frp.Start(context.Background()); err != nil {
		t.Fatal("duplicate start should be harmless")
	}
	if err := frp.Stop(); err != nil || frp.Status().Enabled {
		t.Fatalf("frpc stop: %v", err)
	}
	if err := frp.Stop(); err != nil {
		t.Fatal("duplicate stop should be harmless")
	}
	if host, port := SplitHostPort("relay.example.test:7000"); host != "relay.example.test" || port != "7000" {
		t.Fatalf("split host port: %q %q", host, port)
	}
	if host, port := SplitHostPort("relay.example.test"); host != "relay.example.test" || port != "" {
		t.Fatalf("split bare host: %q %q", host, port)
	}

	writeLongRunningBinary(t, binDir, "cloudflared")
	cloudflare := newCloudflareProvider(TunnelProviderConfig{}, binDir, slogTestLogger())
	if !cloudflare.IsInstalled() || cloudflare.Install(context.Background()) != nil {
		t.Fatal("preinstalled cloudflared should be accepted")
	}
	if err := cloudflare.Start(context.Background()); err == nil || !strings.Contains(err.Error(), "token") {
		t.Fatalf("missing cloudflare token: %v", err)
	}
	cloudflare.config.Token = "token"
	if err := cloudflare.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if err := cloudflare.Start(context.Background()); err != nil {
		t.Fatal("duplicate cloudflare start should be harmless")
	}
	if !cloudflare.Status().Available || !cloudflare.Capabilities().Web {
		t.Fatal("cloudflare status or capabilities")
	}
	if err := cloudflare.Stop(); err != nil {
		t.Fatal(err)
	}
	if err := cloudflare.Stop(); err != nil {
		t.Fatal("duplicate cloudflare stop should be harmless")
	}

	service := NewTunnelService(TunnelConfig{
		Providers: map[TunnelProviderType]TunnelProviderConfig{
			"unknown": {Enabled: true},
		},
	}, binDir)
	if err := service.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(service.Config().Providers) != 1 {
		t.Fatal("service config should include provider")
	}
	service.SetConfig(TunnelConfig{Providers: map[TunnelProviderType]TunnelProviderConfig{
		TunnelProviderCloudflare: {Token: "token", Enabled: false},
	}})
	if !service.GetStatus().Available {
		t.Fatal("configured cloudflare should be available")
	}
}
