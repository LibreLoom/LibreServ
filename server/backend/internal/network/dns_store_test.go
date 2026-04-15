package network

import (
	"context"
	"errors"
	"net/netip"
	"testing"

	"github.com/libdns/libdns"
)

type mockRecordSetter struct {
	calls []struct {
		zone    string
		records []libdns.Record
	}
	err error
}

func (m *mockRecordSetter) SetRecords(ctx context.Context, zone string, records []libdns.Record) ([]libdns.Record, error) {
	m.calls = append(m.calls, struct {
		zone    string
		records []libdns.Record
	}{zone, records})
	return nil, m.err
}

type mockProvider struct {
	*mockRecordSetter
}

func (m *mockProvider) Validate(ctx context.Context, zone string) error {
	return nil
}

func (m *mockProvider) Records() libdns.RecordSetter {
	return m.mockRecordSetter
}

func TestDNSProviderManagerGetConfigEmpty(t *testing.T) {
	db := setupTestDB(t)
	mgr := NewDNSProviderManager(db)

	cfg, err := mgr.GetConfig(t.Context())
	if err != nil {
		t.Fatalf("GetConfig returned error: %v", err)
	}
	if cfg != nil {
		t.Fatal("expected nil config when table is empty")
	}
}

func TestDNSProviderManagerSaveAndGetConfig(t *testing.T) {
	db := setupTestDB(t)
	mgr := NewDNSProviderManager(db)

	original := &DNSProviderConfig{
		Provider: ProviderCloudflare,
		Domain:   "example.com",
		APIToken: "test-api-token-12345",
		Enabled:  true,
	}

	if err := mgr.SaveConfig(context.Background(), original); err != nil {
		t.Fatalf("SaveConfig failed: %v", err)
	}
	if original.ID == "" {
		t.Fatal("expected ID to be generated")
	}

	got, err := mgr.GetConfig(t.Context())
	if err != nil {
		t.Fatalf("GetConfig failed: %v", err)
	}
	if got == nil {
		t.Fatal("expected config, got nil")
	}
	if got.Provider != original.Provider {
		t.Errorf("Provider = %q, want %q", got.Provider, original.Provider)
	}
	if got.Domain != original.Domain {
		t.Errorf("Domain = %q, want %q", got.Domain, original.Domain)
	}
	if got.APIToken != original.APIToken {
		t.Errorf("APIToken = %q, want %q", got.APIToken, original.APIToken)
	}
}

func TestDNSProviderManagerSaveUpdateConfig(t *testing.T) {
	db := setupTestDB(t)
	mgr := NewDNSProviderManager(db)

	cfg := &DNSProviderConfig{
		Provider: ProviderCloudflare,
		Domain:   "example.com",
		APIToken: "old-token",
		Enabled:  true,
	}
	if err := mgr.SaveConfig(context.Background(), cfg); err != nil {
		t.Fatalf("first SaveConfig failed: %v", err)
	}
	originalCreatedAt := cfg.CreatedAt
	if originalCreatedAt.IsZero() {
		t.Fatal("expected CreatedAt to be set after first save")
	}

	cfg.APIToken = "new-token"
	if err := mgr.SaveConfig(context.Background(), cfg); err != nil {
		t.Fatalf("second SaveConfig failed: %v", err)
	}

	got, err := mgr.GetConfig(t.Context())
	if err != nil {
		t.Fatalf("GetConfig failed: %v", err)
	}
	if got.APIToken != "new-token" {
		t.Errorf("APIToken = %q, want %q", got.APIToken, "new-token")
	}
	if got.CreatedAt.Unix() != originalCreatedAt.Unix() {
		t.Errorf("CreatedAt.Unix() = %v, want %v (should be preserved on update)", got.CreatedAt.Unix(), originalCreatedAt.Unix())
	}
	if got.UpdatedAt.Unix() < got.CreatedAt.Unix() {
		t.Errorf("UpdatedAt = %v, should be >= CreatedAt %v", got.UpdatedAt, got.CreatedAt)
	}
}

func TestDNSProviderManagerNewProviderCloudflare(t *testing.T) {
	db := setupTestDB(t)
	mgr := NewDNSProviderManager(db)

	cfg := &DNSProviderConfig{
		Provider: ProviderCloudflare,
		APIToken: "test-token",
	}
	p, err := mgr.NewProvider(cfg)
	if err != nil {
		t.Fatalf("NewProvider failed: %v", err)
	}
	cf, ok := p.(*CloudflareProvider)
	if !ok {
		t.Fatal("expected *CloudflareProvider")
	}
	if cf == nil {
		t.Fatal("expected non-nil provider")
	}
}

func TestDNSProviderManagerNewProviderUnsupported(t *testing.T) {
	db := setupTestDB(t)
	mgr := NewDNSProviderManager(db)

	cfg := &DNSProviderConfig{
		Provider: "route53",
		APIToken: "test",
	}
	_, err := mgr.NewProvider(cfg)
	if err == nil {
		t.Fatal("expected error for unsupported provider")
	}
}

func TestSetupWildcardDNS(t *testing.T) {
	mock := &mockRecordSetter{}
	p := &mockProvider{mockRecordSetter: mock}

	mgr := &DNSProviderManager{}
	cfg := &DNSProviderConfig{
		Provider: ProviderCloudflare,
		Domain:   "example.com",
		APIToken: "test-token",
	}
	ip, _ := netip.ParseAddr("203.0.113.1")

	err := mgr.setupWildcardDNSWithProvider(t.Context(), cfg, ip, p)
	if err != nil {
		t.Fatalf("SetupWildcardDNS failed: %v", err)
	}

	if len(mock.calls) != 2 {
		t.Fatalf("captured %d calls, want 2", len(mock.calls))
	}
	if mock.calls[0].zone != "example.com." {
		t.Errorf("first call zone = %q, want example.com.", mock.calls[0].zone)
	}
	if mock.calls[1].zone != "example.com." {
		t.Errorf("second call zone = %q, want example.com.", mock.calls[1].zone)
	}

	recs := append([]libdns.Record(nil), mock.calls[0].records...)
	recs = append(recs, mock.calls[1].records...)
	for i, rec := range recs {
		addr, ok := rec.(libdns.Address)
		if !ok {
			t.Fatalf("record %d is not libdns.Address", i)
		}
		if i == 0 && addr.Name != "" {
			t.Errorf("first record name = %q, want empty (apex)", addr.Name)
		}
		if i == 1 && addr.Name != "*" {
			t.Errorf("second record name = %q, want *", addr.Name)
		}
	}
}

func (m *DNSProviderManager) setupWildcardDNSWithProvider(ctx context.Context, cfg *DNSProviderConfig, ip netip.Addr, p DNSProvider) error {
	zone := cfg.Zone()
	s := p.Records()
	if err := SetARecord(ctx, s, zone, "", ip, defaultDNSTTL); err != nil {
		return err
	}
	return SetARecord(ctx, s, zone, "*", ip, defaultDNSTTL)
}

func TestSetupWildcardDNSErrors(t *testing.T) {
	mock := &mockRecordSetter{err: errors.New("dns error")}
	p := &mockProvider{mockRecordSetter: mock}

	mgr := &DNSProviderManager{}
	cfg := &DNSProviderConfig{
		Provider: ProviderCloudflare,
		Domain:   "example.com",
		APIToken: "test-token",
	}
	ip, _ := netip.ParseAddr("203.0.113.1")

	err := mgr.setupWildcardDNSWithProvider(t.Context(), cfg, ip, p)
	if err == nil {
		t.Fatal("expected error from SetARecord")
	}
}
