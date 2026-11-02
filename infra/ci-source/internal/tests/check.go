package tests

import (
	"path/filepath"
	"sort"
	"strings"
)

// A check is a test that reads the code and fails on a defect without running
// product logic: format, vet, lint, typecheck, colour scan, static analysis.
// They are the fast inner loop — an agent runs them after every edit — while
// the real tests are the slow, unattended pass.
//
// The classification is explicit rather than derived from Type: fmt, vet, lint
// and typecheck are all filed under TestTypeUnit today alongside genuine unit
// tests, so Type alone cannot tell the two apart.
var checkIDs = map[string]bool{
	"go-fmt":                         true,
	"go-vet":                         true,
	"connect-fmt":                    true,
	"connect-vet":                    true,
	"luna-connect-fmt":               true,
	"luna-connect-vet":               true,
	"frontend-lint":                  true,
	"frontend-typecheck":             true,
	"frontend-colors":                true,
	"connect-web-admin-lint":         true,
	"connect-web-admin-typecheck":    true,
	"connect-web-customer-lint":      true,
	"connect-web-customer-typecheck": true,
	"luna-connect-web-lint":          true,
	"luna-connect-web-typecheck":     true,
	"luna-connect-web-colors":        true,
	"luna-web-colors":                true,
	"luna-web-lint":                  true,
	"luna-web-typecheck":             true,
	"staticcheck":                    true,
	"connect-staticcheck":            true,
	"gosec":                          true,
	"connect-gosec":                  true,
	"govulncheck":                    true,
}

// SlowChecks are checks that install a tool (go install) or scan the whole
// module on every run. They are worth running before a commit, not after every
// edit, so `ci check` leaves them out unless asked.
var slowChecks = map[string]bool{
	"staticcheck":         true,
	"connect-staticcheck": true,
	"gosec":               true,
	"connect-gosec":       true,
	"govulncheck":         true,
}

// IsCheck reports whether a test ID is a static check.
func IsCheck(id string) bool { return checkIDs[id] }

// IsSlowCheck reports whether a check is too slow for the default `ci check`.
func IsSlowCheck(id string) bool { return slowChecks[id] }

// CheckIDs returns every static check, in registry order. With fastOnly, the
// slow ones (staticcheck, gosec, govulncheck) are omitted.
func CheckIDs(fastOnly bool) []string {
	var ids []string
	for _, t := range DefaultRegistry.List() {
		if !checkIDs[t.ID] {
			continue
		}
		if fastOnly && slowChecks[t.ID] {
			continue
		}
		ids = append(ids, t.ID)
	}
	return ids
}

// pathOverrides widens a test's selection beyond its WorkDir. The tree is
// derived from WorkDir, which is right for almost everything; these are the
// cases where a change reaches a test whose WorkDir does not contain it.
var pathOverrides = map[string][]string{
	// shared/ui is a workspace dependency of both webs, so a change there can
	// break either one's build, colours and tests.
	"shared/ui": {
		"frontend-lint", "frontend-typecheck", "frontend-colors", "frontend-test", "frontend-build",
		"luna-web-colors", "luna-web-recovery-login-test", "luna-web-e2e",
	},
	// The release keys are embedded into Sol and lunad at build time.
	"keys": {"go-build", "luna-ci"},
}

// repoWideTests are the tests whose WorkDir is the repo root: any change can
// affect them.
var repoWideTests = map[string]bool{
	"luna-ci":      true,
	"podman-build": true,
}

// TestsForPaths returns the tests a set of changed repo-relative paths can
// affect, in registry order. An empty or unrecognised path set selects
// everything: under-selecting ships a broken change, so widening is the
// default when the mapping cannot say for sure.
func TestsForPaths(paths []string) []*Test {
	if len(paths) == 0 {
		return DefaultRegistry.List()
	}

	selected := make(map[string]bool)
	matched := false

	for _, t := range DefaultRegistry.List() {
		if repoWideTests[t.ID] {
			// Selected unconditionally, but they do not count as a path match:
			// otherwise an unrecognised path would look understood and run only
			// these two tests.
			selected[t.ID] = true
			continue
		}
		workDir := strings.TrimPrefix(t.WorkDir, "/repo/")
		for _, p := range paths {
			if workDir != "" && (p == workDir || strings.HasPrefix(p, workDir+"/")) {
				selected[t.ID] = true
				matched = true
				break
			}
		}
	}

	// Path overrides: a change under shared/ui or keys reaches tests whose own
	// WorkDir is elsewhere.
	for _, p := range paths {
		for prefix, ids := range pathOverrides {
			if p == prefix || strings.HasPrefix(p, prefix+"/") {
				for _, id := range ids {
					selected[id] = true
				}
				matched = true
			}
		}
	}

	// A path that matched nothing (docs, a new top-level dir, a file outside
	// every WorkDir) means the mapping does not understand this change. Select
	// everything rather than silently run nothing.
	if !matched {
		return DefaultRegistry.List()
	}

	var result []*Test
	for _, t := range DefaultRegistry.List() {
		if selected[t.ID] {
			result = append(result, t)
		}
	}
	return result
}

// FilterChecks narrows tests to the static checks, keeping registry order.
func FilterChecks(list []*Test, fastOnly bool) []*Test {
	var result []*Test
	for _, t := range list {
		if !checkIDs[t.ID] {
			continue
		}
		if fastOnly && slowChecks[t.ID] {
			continue
		}
		result = append(result, t)
	}
	return result
}

// NormalizePaths makes changed paths repo-relative and slash-separated, so the
// caller can pass whatever git printed.
func NormalizePaths(root string, paths []string) []string {
	out := make([]string, 0, len(paths))
	for _, p := range paths {
		p = strings.TrimSpace(p)
		if p == "" {
			continue
		}
		if filepath.IsAbs(p) {
			if rel, err := filepath.Rel(root, p); err == nil {
				p = rel
			}
		}
		p = filepath.ToSlash(strings.TrimPrefix(p, "./"))
		out = append(out, p)
	}
	sort.Strings(out)
	return out
}
