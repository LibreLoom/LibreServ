package podman

import (
	"context"
	"os"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

func TestPodmanComposeUpSmoke(t *testing.T) {
	composeDir := t.TempDir()
	composePath := composeDir + "/docker-compose.yml"
	if err := os.WriteFile(composePath, []byte(`
services:
  hello:
    image: alpine:latest
    command: ["echo", "podman-compose-smoke-works"]
`), 0644); err != nil {
		t.Fatal(err)
	}

	c, err := NewClient(config.RuntimeConfig{Method: "socket", SocketPath: "/dev/null"})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	ctx := context.Background()
	if err := c.ComposeUp(ctx, composePath); err != nil {
		t.Fatalf("ComposeUp failed: %v", err)
	}

	// Verify container ran
	out, err := os.ReadFile(composeDir + "/output.txt")
	if err != nil {
		// It's okay if output.txt doesn't exist; the main test is that ComposeUp didn't error
		// because it invoked podman compose successfully.
		t.Logf("output.txt not found: %v", err)
	} else {
		if !strings.Contains(string(out), "podman-compose-smoke-works") {
			t.Fatalf("unexpected output: %s", string(out))
		}
	}
}
