package engine

import "path/filepath"

// BuildContext is everything a Part needs to describe its jobs.
type BuildContext struct {
	Engine *Engine
	// Unit is the release unit being built ("luna", "sol", ...).
	Unit string
	// Version is the version stamped into the build (release or dev).
	Version string
	// Commit is the full SHA being built.
	Commit string
	// SrcDir is the exported source tree (see Engine.Export).
	SrcDir string
	// OutRoot is the output root; use PartOutDir for a part's own dir.
	OutRoot string
}

// PartOutDir is the per-part output dir: <OutRoot>/<unit>/<version>/<part>.
// The caller creates it (see EnsureOutDir).
func (b *BuildContext) PartOutDir(part string) string {
	return joinPath(b.OutRoot, b.Unit, b.Version, part)
}

// Part is one buildable piece of a unit (a binary, a web bundle, an image).
// A Part contributes jobs to the build graph; jobs of different parts depend
// on each other by ID (e.g. "luna/lunad" depends on "luna/web").
type Part interface {
	// Name is the part's ID within its unit ("lunad", "web", "apk").
	Name() string
	// Unit is the release unit that owns the part.
	Unit() string
	// Jobs returns the part's jobs. Job IDs must be "<unit>/<part>" or
	// "<unit>/<part>:<step>" so they are unique across units.
	Jobs(b *BuildContext) ([]Job, error)
}

// BuildGraph asks every part for its jobs and assembles a validated graph.
func BuildGraph(b *BuildContext, parts []Part) (*Graph, error) {
	g := NewGraph()
	for _, p := range parts {
		jobs, err := p.Jobs(b)
		if err != nil {
			return nil, err
		}
		if err := g.Add(jobs...); err != nil {
			return nil, err
		}
	}
	if err := g.Validate(); err != nil {
		return nil, err
	}
	return g, nil
}

func joinPath(elem ...string) string {
	out := ""
	for _, e := range elem {
		if e == "" {
			continue
		}
		if out == "" {
			out = e
		} else {
			out = filepath.Join(out, e)
		}
	}
	return out
}
