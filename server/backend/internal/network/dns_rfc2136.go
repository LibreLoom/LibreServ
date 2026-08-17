package network

import (
	"context"
	"fmt"

	"github.com/libdns/libdns"
	"github.com/libdns/rfc2136"
)

// RFC2136Provider is a DNS provider that updates records via dynamic DNS
// UPDATE (RFC 2136) against the zone's authoritative nameserver. This is the
// generic BYO path for users whose registrar/DNS host speaks RFC 2136 but
// has no per-provider libdns integration.
type RFC2136Provider struct {
	provider *rfc2136.Provider
}

// NewRFC2136Provider builds an RFC 2136 provider from a config.
// server is the authoritative nameserver host:port (e.g. "ns1.example.com:53"),
// keyName the TSIG key name, key the TSIG secret (base64), keyAlg the TSIG
// algorithm (defaults hmac-sha256).
func NewRFC2136Provider(server, keyName, key, keyAlg string) *RFC2136Provider {
	alg := keyAlg
	if alg == "" {
		alg = "hmac-sha256"
	}
	return &RFC2136Provider{
		provider: &rfc2136.Provider{
			Server:  server,
			KeyName: keyName,
			Key:     key,
			KeyAlg:  alg,
		},
	}
}

func (p *RFC2136Provider) Validate(ctx context.Context, zone string) error {
	// Validate by attempting to list records in the zone. Some RFC 2136
	// servers restrict listing; a failure here may be a permissions issue
	// rather than a config issue, so keep the message plain.
	if _, err := p.provider.GetRecords(ctx, zone); err != nil {
		return fmt.Errorf("rfc2136 validate (check the nameserver, key name, and secret): %w", err)
	}
	return nil
}

func (p *RFC2136Provider) Records() libdns.RecordSetter {
	return p.provider
}
