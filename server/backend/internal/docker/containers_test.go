package docker

import (
	"testing"
)

// This test ensures the label filter wiring doesn't panic or error when no daemon is present.
// It uses a nil client context; we only assert that constructing a Client and calling the method
// returns an error (or zero containers), not a panic.
func TestListContainersByLabel_NoDaemon(t *testing.T) {
	c := &Client{cli: nil, ctx: nil}
	if _, err := c.ListContainersByLabel("libreserv.app=test"); err == nil {
		// If no error, that's fine; if daemon is not available, an error is also expected.
		// The main goal is to avoid panic.
		t.Log("ListContainersByLabel returned without error (daemon likely available in env)")
	}
}
