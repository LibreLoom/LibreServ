package support

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// SafeWorkdir returns a scratch directory for support commands.
func SafeWorkdir() string {
	dir := filepath.Join(os.TempDir(), "libreserv-support")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

// ValidateDockerArgs enforces a minimal allowlist of docker subcommands and blocks dangerous flags.
func ValidateDockerArgs(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("docker subcommand required")
	}
	sub := args[0]
	allowedSubs := map[string]bool{
		"ps":      true,
		"info":    true,
		"version": true,
		"stats":   true,
		"inspect": true,
		"logs":    true,
	}
	if !allowedSubs[sub] {
		return fmt.Errorf("docker subcommand not allowed: %s", sub)
	}
	for _, a := range args[1:] {
		la := strings.ToLower(a)
		switch {
		case strings.HasPrefix(la, "-v"), strings.HasPrefix(la, "--volume"),
			strings.HasPrefix(la, "--mount"), strings.HasPrefix(la, "--privileged"),
			strings.HasPrefix(la, "--cap-add"), strings.HasPrefix(la, "--device"),
			strings.HasPrefix(la, "--publish"), strings.HasPrefix(la, "-p"),
			strings.HasPrefix(la, "--network"), strings.HasPrefix(la, "--net"),
			strings.HasPrefix(la, "--pid"), strings.HasPrefix(la, "--ipc"):
			return fmt.Errorf("docker flag not allowed: %s", a)
		}
	}
	return nil
}
