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
	// AndroidSigning is the release keystore for luna-android/apk; nil builds
	// an unsigned (debug-signed) dev APK.
	AndroidSigning *AndroidSigning
	// Only lists the parts the caller named (--parts); empty means the whole
	// unit. A part that can skip itself (luna's os and installer) never skips
	// when it is named.
	Only []string
	// Rebuild forces parts that would otherwise be skipped or reused to build.
	Rebuild bool
	// Released looks up the newest released file of a part in the live feeds
	// (set for cuts only; nil for dev builds, which never touch the network
	// to decide what to build).
	Released func(part string) (Released, bool)
}

// Released is a file an earlier release shipped, as the live feeds list it.
type Released struct {
	Version string
	// URL is the file's public registry address.
	URL    string
	SHA256 string
	Size   int64
}

// Named reports whether the caller asked for this part by name.
func (b *BuildContext) Named(part string) bool {
	for _, n := range b.Only {
		if n == part {
			return true
		}
	}
	return false
}

// AndroidSigning is a release keystore for the gradle job. Path is mounted
// read-only; the passwords travel in the job's environment, never argv.
type AndroidSigning struct {
	Path          string
	Alias         string
	StorePassword string
	KeyPassword   string
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
