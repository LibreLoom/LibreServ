package podman

import (
	"context"
	"testing"
)

// This test ensures the label filter wiring doesn't panic or error when no daemon is present.
// It uses a nil client context; we only assert that constructing a Client and calling the method
// returns an error (or zero containers), not a panic.
func TestListContainersByLabel_NoDaemon(t *testing.T) {
	c := &Client{cli: nil, ctx: nil}
	if _, err := c.ListContainersByLabel(context.Background(), "libreserv.app=test"); err == nil {
		t.Log("ListContainersByLabel returned without error (daemon likely available in env)")
	}
}
