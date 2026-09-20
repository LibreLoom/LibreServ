package network

import (
	"context"
	"fmt"

	"github.com/libdns/cloudflare"
	"github.com/libdns/libdns"
)

type CloudflareProvider struct {
	provider *cloudflare.Provider
}

func NewCloudflareProvider(apiToken string) *CloudflareProvider {
	return &CloudflareProvider{
		provider: &cloudflare.Provider{APIToken: apiToken},
	}
}

func (p *CloudflareProvider) Validate(ctx context.Context, zone string) error {
	_, err := p.provider.GetRecords(ctx, zone)
	if err != nil {
		return fmt.Errorf("cloudflare validate: %w", err)
	}
	return nil
}

func (p *CloudflareProvider) Records() libdns.RecordSetter {
	return p.provider
}
