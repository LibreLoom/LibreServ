package network

import (
	"testing"
)

func TestCloudflareProviderRecords(t *testing.T) {
	p := NewCloudflareProvider("test-token")
	setter := p.Records()
	if setter == nil {
		t.Fatal("Records() returned nil")
	}
}

func TestCloudflareProviderValidateBadToken(t *testing.T) {
	p := NewCloudflareProvider("invalid-token")
	err := p.Validate(t.Context(), "example.com.")
	if err == nil {
		t.Fatal("expected validation error for invalid token")
	}
}

func TestDNSProviderConfigZone(t *testing.T) {
	tests := []struct {
		domain string
		zone   string
	}{
		{"example.com", "example.com."},
		{"example.com.", "example.com."},
		{"", ""},
	}
	for _, tt := range tests {
		cfg := &DNSProviderConfig{Domain: tt.domain}
		if got := cfg.Zone(); got != tt.zone {
			t.Errorf("Zone(%q) = %q, want %q", tt.domain, got, tt.zone)
		}
	}
}

func TestCloudflareProviderImplementsDNSProvider(t *testing.T) {
	p := NewCloudflareProvider("test")
	var _ DNSProvider = p
	if p.Records() == nil {
		t.Fatal("Records() returned nil")
	}
}
