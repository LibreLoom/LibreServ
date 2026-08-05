package network

import (
	"context"
)

// ConnectVerifier adapts the LibreServ Connect client to the Verifier
// interface: it asks Connect's edge (Hetzner) to probe host:port from
// outside, because the device cannot grade its own homework.
type ConnectVerifier struct {
	// Probe is the Connect client's VerifyProbe method.
	Probe func(ctx context.Context, host string, port int, protocol string) (bool, error)
}

func (c *ConnectVerifier) Verify(ctx context.Context, host string, port int, protocol string) (bool, error) {
	if c == nil || c.Probe == nil {
		return false, nil
	}
	return c.Probe(ctx, host, port, protocol)
}
