// Package parts holds the builders for every release unit. Each unit's file
// registers its parts in init(); the CLI and TUI look them up here.
package parts

import (
	"sort"
	"sync"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

var (
	mu    sync.Mutex
	units = map[string][]engine.Part{}
)

// Register adds parts to a unit. Called from init() in the unit's file.
func Register(unit string, ps ...engine.Part) {
	mu.Lock()
	defer mu.Unlock()
	units[unit] = append(units[unit], ps...)
}

// For returns a unit's parts, or nil if the unit has none registered.
func For(unit string) []engine.Part {
	mu.Lock()
	defer mu.Unlock()
	return append([]engine.Part(nil), units[unit]...)
}

// Units lists every unit with registered parts, sorted.
func Units() []string {
	mu.Lock()
	defer mu.Unlock()
	out := make([]string, 0, len(units))
	for u := range units {
		out = append(out, u)
	}
	sort.Strings(out)
	return out
}
