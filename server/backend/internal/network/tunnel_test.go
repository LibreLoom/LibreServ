package network

import (
	"context"
	"io"
	"log/slog"
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
