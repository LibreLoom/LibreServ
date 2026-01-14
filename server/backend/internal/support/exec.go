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
		if isDangerousDockerFlag(a) {
			return fmt.Errorf("docker flag not allowed: %s", a)
		}
	}
	return nil
}

// isDangerousDockerFlag checks if an argument is a dangerous docker flag.
// Handles various flag formats: -v, --volume, --volume=path, -v=path
func isDangerousDockerFlag(arg string) bool {
	la := strings.ToLower(arg)

	// Strip leading dashes and extract flag name (before any '=')
	flagPart := strings.TrimLeft(la, "-")
	if idx := strings.Index(flagPart, "="); idx != -1 {
		flagPart = flagPart[:idx]
	}

	// Dangerous flags that could allow container escape or privilege escalation
	dangerousFlags := map[string]bool{
		"v":            true,
		"volume":       true,
		"mount":        true,
		"privileged":   true,
		"cap-add":      true,
		"device":       true,
		"publish":      true,
		"p":            true,
		"network":      true,
		"net":          true,
		"pid":          true,
		"ipc":          true,
		"uts":          true,
		"userns":       true,
		"cgroupns":     true,
		"security-opt": true,
		"add-host":     true,
	}

	return dangerousFlags[flagPart]
}
