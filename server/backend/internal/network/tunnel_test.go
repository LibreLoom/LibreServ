package network

import (
	"context"
	"io"
	"log/slog"
	"os"
	"strings"
	"sync"
	"testing"
)

// fakeProvider records Start/Stop calls so tests can assert provider isolation.
type fakeProvider struct {
	mu       sync.Mutex
	starts   int
	stops    int
	provider TunnelProviderType
}

func (f *fakeProvider) Start(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.starts++
	return nil
}

func (f *fakeProvider) Stop() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.stops++
	return nil
}

func (f *fakeProvider) IsInstalled() bool { return true }
func (f *fakeProvider) Install(ctx context.Context) error {
	return nil
}
func (f *fakeProvider) Status() TunnelStatus {
	return TunnelStatus{Available: true, Provider: f.provider}
}

func (f *fakeProvider) Capabilities() Capabilities {
	return Capabilities{Web: true, TCP: true, UDP: true}
}

func TestTunnelServiceMultiProvider(t *testing.T) {
	const (
		pA TunnelProviderType = "fake-a"
		pB TunnelProviderType = "fake-b"
	)

	// Registry lets the service construct fake providers by name.
	registry := map[TunnelProviderType]*fakeProvider{
		pA: {provider: pA},
		pB: {provider: pB},
	}

	ts := &TunnelService{
		providers: make(map[TunnelProviderType]*providerEntry),
		logger:    slogTestLogger(),
	}
	ts.providerFactory = func(pt TunnelProviderType, cfg TunnelProviderConfig) TunnelProvider {
		return registry[pt]
	}

	// Enable A then B: enabling B must not stop A.
	if err := ts.Enable(pA, "token-a"); err != nil {
		t.Fatalf("Enable A: %v", err)
	}
	if err := ts.Enable(pB, "token-b"); err != nil {
		t.Fatalf("Enable B: %v", err)
	}

	if registry[pA].stops != 0 {
		t.Errorf("enabling B stopped provider A (%d stops)", registry[pA].stops)
	}

	// Start starts both enabled providers.
	if err := ts.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if registry[pA].starts != 1 || registry[pB].starts != 1 {
		t.Errorf("Start: starts = %d/%d, want 1/1", registry[pA].starts, registry[pB].starts)
	}

	// Disable only B; A stays enabled.
	if err := ts.Disable(pB); err != nil {
		t.Fatalf("Disable B: %v", err)
	}
	if registry[pB].stops != 1 {
		t.Errorf("Disable B: stops = %d, want 1", registry[pB].stops)
	}
	if registry[pA].stops != 0 {
		t.Errorf("Disable B stopped provider A (%d stops)", registry[pA].stops)
	}

	// Disable() with no args stops everything.
	if err := ts.Disable(); err != nil {
		t.Fatalf("Disable all: %v", err)
	}
	if registry[pA].stops != 1 || registry[pB].stops != 2 {
		t.Errorf("Disable all: stops = %d/%d, want 1/2", registry[pA].stops, registry[pB].stops)
	}

	// Status reports both providers.
	status := ts.GetStatus()
	if len(status.Providers) != 2 {
		t.Fatalf("Status providers = %d, want 2", len(status.Providers))
	}
}

func slogTestLogger() *slog.Logger {
	return slog.New(slog.NewTextHandler(io.Discard, nil))
}

func TestProviderCapabilities(t *testing.T) {
	cf := newCloudflareProvider(TunnelProviderConfig{Token: "t"}, "/tmp", slogTestLogger())
	caps := cf.Capabilities()
	if !caps.Web {
		t.Error("cloudflared should be web-capable")
	}
	if caps.TCP || caps.UDP {
		t.Errorf("cloudflared must be web-only, got %+v", caps)
	}

	frp := newFRPProvider(FRPConfig{}, "/tmp", slogTestLogger())
	fcaps := frp.Capabilities()
	if !fcaps.Web || !fcaps.TCP || !fcaps.UDP {
		t.Errorf("frp should carry web+TCP+UDP, got %+v", fcaps)
	}
}

func TestFRPConfigGeneration(t *testing.T) {
	f := newFRPProvider(FRPConfig{
		TunnelProviderConfig: TunnelProviderConfig{Token: "secret-token"},
		Server:               "relay.example.com:7000",
		TLSEnabled:           true,
		Proxies: []FRPProxy{
			{Name: "minecraft", LocalPort: 25565, RemotePort: 25565, Type: "udp"},
			{Name: "web", LocalPort: 8080, RemotePort: 8080},
		},
	}, "/tmp", slogTestLogger())

	// writeConfig writes to binDir — use a temp dir via the provider's path.
	// Instead of hitting the real binary path, verify the toml content logic
	// through a direct call with a temp bin dir.
	cfg, err := f.writeConfig()
	if err != nil {
		t.Fatalf("writeConfig: %v", err)
	}
	data, err := os.ReadFile(cfg)
	if err != nil {
		t.Fatalf("read config: %v", err)
	}
	content := string(data)
	for _, want := range []string{
		`serverAddr = "relay.example.com"`,
		`serverPort = 7000`,
		`auth.token = "secret-token"`,
		`transport.tls.enable = true`,
		`transport.tls.serverName = "relay.example.com"`,
		`name = "minecraft"`,
		`type = "udp"`,
		`localPort = 25565`,
		`remotePort = 25565`,
		`name = "web"`,
	} {
		if !strings.Contains(content, want) {
			t.Errorf("config missing %q\n%s", want, content)
		}
	}
}

// TestTunnelEnableWithNewTokenRestartsProvider guards the supersede path: when
// a new token is enabled for an already-running provider, the stale cloudflared
// must be stopped so the new token actually takes effect (Start() is a no-op
// while a process is still running).
func TestTunnelEnableWithNewTokenRestartsProvider(t *testing.T) {
	const pA TunnelProviderType = "fake-a"
	reg := map[TunnelProviderType]*fakeProvider{pA: {provider: pA}}
	ts := &TunnelService{
		providers: make(map[TunnelProviderType]*providerEntry),
		logger:    slogTestLogger(),
	}
	ts.providerFactory = func(pt TunnelProviderType, cfg TunnelProviderConfig) TunnelProvider {
		return reg[pt]
	}

	if err := ts.Enable(pA, "token-old"); err != nil {
		t.Fatalf("Enable: %v", err)
	}
	if err := ts.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	if reg[pA].starts != 1 {
		t.Fatalf("starts = %d, want 1", reg[pA].starts)
	}

	// Supersede: same provider, new token — the running instance must stop.
	if err := ts.Enable(pA, "token-new"); err != nil {
		t.Fatalf("re-Enable: %v", err)
	}
	if reg[pA].stops != 1 {
		t.Errorf("stops = %d, want 1 (stale tunnel must be stopped)", reg[pA].stops)
	}
	if err := ts.Start(context.Background()); err != nil {
		t.Fatalf("Start after supersede: %v", err)
	}
	if reg[pA].starts != 2 {
		t.Errorf("starts = %d, want 2 (restart with new token)", reg[pA].starts)
	}
}
