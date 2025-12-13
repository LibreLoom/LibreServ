package network

import (
	"context"
	"testing"
	"time"
)

func TestResolveHostname(t *testing.T) {
	res, err := ResolveHostname(context.Background(), "localhost", 2*time.Second)
	if err != nil {
		t.Fatalf("resolve: %v", err)
	}
	if res.Hostname != "localhost" {
		t.Fatalf("hostname mismatch")
	}
}
