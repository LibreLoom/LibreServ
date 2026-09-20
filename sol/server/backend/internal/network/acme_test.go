package network

import (
	"testing"
)

func TestLegoProviderConfigCloudflare(t *testing.T) {
	cfg := &DNSProviderConfig{
		Provider: ProviderCloudflare,
		APIToken: "test-token-123",
	}
	provider, env, err := legoProviderConfig(cfg)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if provider != "cloudflare" {
		t.Errorf("provider = %q, want cloudflare", provider)
	}
	if env["CLOUDFLARE_DNS_API_TOKEN"] != "test-token-123" {
		t.Errorf("CLOUDFLARE_DNS_API_TOKEN = %q, want test-token-123", env["CLOUDFLARE_DNS_API_TOKEN"])
	}
}

func TestLegoProviderConfigUnsupported(t *testing.T) {
	cfg := &DNSProviderConfig{
		Provider: "route53",
		APIToken: "test",
	}
	_, _, err := legoProviderConfig(cfg)
	if err == nil {
		t.Fatal("expected error for unsupported provider")
	}
}
