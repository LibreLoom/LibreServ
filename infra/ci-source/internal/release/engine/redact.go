package engine

import (
	"sort"
	"strings"
	"sync"
)

// Redactor scrubs registered secret values from log lines. Every line leaves
// the engine through one, so secrets registered later (after proving) are
// hidden from then on. The zero value is ready to use.
type Redactor struct {
	mu      sync.RWMutex
	secrets []string // longest first
}

// Mask replaces every redacted value.
const Mask = "***"

// Add registers values to hide. Empty and very short values are ignored (they
// would mangle ordinary text).
func (r *Redactor) Add(values ...string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for _, v := range values {
		if len(v) < 4 {
			continue
		}
		dup := false
		for _, s := range r.secrets {
			if s == v {
				dup = true
				break
			}
		}
		if !dup {
			r.secrets = append(r.secrets, v)
		}
	}
	sort.Slice(r.secrets, func(i, j int) bool { return len(r.secrets[i]) > len(r.secrets[j]) })
}

// Redact returns line with every registered secret masked. A nil Redactor
// returns the line unchanged.
func (r *Redactor) Redact(line string) string {
	if r == nil {
		return line
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	for _, s := range r.secrets {
		if strings.Contains(line, s) {
			line = strings.ReplaceAll(line, s, Mask)
		}
	}
	return line
}
