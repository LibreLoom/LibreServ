package handlers

import (
	"fmt"
	"path/filepath"
	"strings"
	"unicode/utf8"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/support"
)

// validateCommandPaths ensures any path-like arguments stay within allow roots.
func validateCommandPaths(policy *support.PathPolicy, cmd string, args []string) error {
	// Only check commands that take file paths
	check := func(path string) error {
		allowed, err := policy.IsAllowed(path)
		if err != nil {
			return err
		}
		if !allowed {
			return fmt.Errorf("path not allowed: %s", path)
		}
		return nil
	}

	switch cmd {
	case "cat", "tail", "ls":
		for _, a := range args {
			// Skip flags
			if strings.HasPrefix(a, "-") {
				continue
			}
			if err := check(a); err != nil {
				return err
			}
		}
	case "journalctl":
		// No path args; skip
	case "docker":
		// Allowed if no volume mounts are manipulated; skip here
	case "df":
		// No path args
	default:
		// default: check any arg that looks like a path
		for _, a := range args {
			if strings.HasPrefix(a, "-") {
				continue
			}
			if strings.Contains(a, "/") {
				clean := filepath.Clean(a)
				if err := check(clean); err != nil {
					return err
				}
			} else if looksLikePath(a) {
				if err := check(filepath.Clean(a)); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func looksLikePath(arg string) bool {
	if arg == "" || !utf8.ValidString(arg) {
		return false
	}
	return strings.Contains(arg, ".") || strings.Contains(arg, string(filepath.Separator))
}
