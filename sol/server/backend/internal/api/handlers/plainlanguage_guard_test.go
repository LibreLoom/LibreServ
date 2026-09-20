package handlers

import (
	"os"
	"strings"
	"testing"
)

// TestPlainLanguageErrorMessages guards the plain-language rule for API errors
// (AGENTS.md → "PLAIN LANGUAGE (non-negotiable)"; GOALS.md production-readiness
// item "Plain-language rule enforced across API error messages").
//
// It fails if any handler returns a raw technical error string to the user via
// JSONError. The forbidden signals are:
//
//   - "failed to …" / "unable to …" — terse developer-facing fragments. The
//     house voice is "We couldn't …" / "Please …", so these phrases signal a
//     regression. (If a message genuinely needs "unable to", reword it to
//     "couldn't" for consistency with the rest of the API.)
//   - "internal server error" — a raw status phrase, never user-facing.
//   - err.Error() passed into JSONError — leaks Go internals.
//
// Assumption: JSONError calls are single-line in this package (true today).
// Keep them on one line so this line-based scan stays accurate.
//
// This file is a _test.go file, so it is excluded from its own scan.
func TestPlainLanguageErrorMessages(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read handlers package dir: %v", err)
	}
	for _, e := range entries {
		name := e.Name()
		if !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		data, err := os.ReadFile(name)
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		for i, raw := range strings.Split(string(data), "\n") {
			line := strings.TrimSpace(raw)
			if strings.HasPrefix(line, "//") { // skip comments
				continue
			}
			if !strings.Contains(line, "JSONError(") {
				continue
			}
			low := strings.ToLower(line)
			switch {
			case strings.Contains(low, "failed to "):
				t.Errorf("%s:%d: JSONError uses \"failed to …\" — rewrite as a plain-language \"We couldn't …\" message (AGENTS.md): %s", name, i+1, line)
			case strings.Contains(low, "unable to "):
				t.Errorf("%s:%d: JSONError uses \"unable to …\" — rewrite as a plain-language \"We couldn't …\" message (AGENTS.md): %s", name, i+1, line)
			case strings.Contains(low, "internal server error"):
				t.Errorf("%s:%d: JSONError leaks a raw status phrase — use a plain-language message (AGENTS.md): %s", name, i+1, line)
			case strings.Contains(line, "err.Error()"):
				t.Errorf("%s:%d: JSONError leaks a Go error via err.Error() — use a plain-language message (AGENTS.md): %s", name, i+1, line)
			}
		}
	}
}
