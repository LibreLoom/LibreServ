package support

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

// PathPolicy holds allow/deny roots for support file operations.
type PathPolicy struct {
	Allow []string
	Deny  []string
}

// NewDefaultPolicy builds a conservative policy with optional extra allow roots.
func NewDefaultPolicy(extraAllow []string) *PathPolicy {
	base := []string{
		"/var/log",               // system logs
		"/var/lib/libreserv",     // app data defaults
		"/etc/libreserv",         // config
		"/tmp/libreserv-support", // scratch
	}
	return &PathPolicy{
		Allow: append(base, extraAllow...),
		Deny: []string{
			"/var/lib/docker", // docker internals
			"/proc",
			"/sys",
			"/dev",
		},
	}
}

// IsAllowed reports whether the given path is within allowed roots and not in deny roots.
func (p *PathPolicy) IsAllowed(path string) (bool, error) {
	if path == "" {
		return false, errors.New("empty path")
	}
	clean := filepath.Clean(path)
	resolved, err := filepath.EvalSymlinks(clean)
	if err != nil {
		// If path doesn't exist yet, fall back to cleaned path
		resolved = clean
	}

	for _, deny := range p.Deny {
		if deny == "" {
			continue
		}
		if startsWith(resolved, deny) {
			return false, nil
		}
	}

	for _, allow := range p.Allow {
		if allow == "" {
			continue
		}
		if startsWith(resolved, allow) {
			return true, nil
		}
	}
	return false, nil
}

// EnsureScratch makes sure the scratch directory exists and is writable.
func (p *PathPolicy) EnsureScratch(path string) error {
	if path == "" {
		return errors.New("scratch path required")
	}
	if err := os.MkdirAll(path, 0o755); err != nil {
		return err
	}
	return nil
}

func startsWith(path, root string) bool {
	path = filepath.Clean(path)
	root = filepath.Clean(root)
	if path == root {
		return true
	}
	if !strings.HasSuffix(root, string(filepath.Separator)) {
		root += string(filepath.Separator)
	}
	return strings.HasPrefix(path, root)
}
