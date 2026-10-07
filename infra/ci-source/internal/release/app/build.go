package app

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"aead.dev/minisign"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
)

// AllUnits is the unit name that builds every unit with parts.
const AllUnits = "all"

// BuildRequest is one `build`.
type BuildRequest struct {
	// Unit is a release unit or AllUnits.
	Unit string
	// Ref is the git ref to build (default HEAD).
	Ref string
	// Parts limits the build to these parts (and what they depend on).
	Parts []string
	// Version overrides the dev version (a single unit only).
	Version string
	// Jobs and HeavyJobs cap parallelism (defaults: CPU count, 2).
	Jobs, HeavyJobs int
	// NoFailFast keeps independent jobs running after a failure.
	NoFailFast bool
	// OutRoot overrides the configured dist/ root.
	OutRoot string
}

// FileOut is one output file.
type FileOut struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}

// UnitBuild is the outcome for one unit.
type UnitBuild struct {
	Unit    string    `json:"unit"`
	Version string    `json:"version"`
	Dir     string    `json:"dir"`
	Files   []FileOut `json:"files"`
	// Missing lists expected release files this build did not produce
	// (normal when only some parts were built).
	Missing []string `json:"missing,omitempty"`
	// Signed is true when SHA256SUMS.txt was signed with the dev key.
	Signed bool `json:"signed"`
}

// BuildResult is what Build returns, also when jobs failed.
type BuildResult struct {
	Commit   string             `json:"commit"`
	Units    []UnitBuild        `json:"units"`
	Jobs     []engine.JobResult `json:"-"`
	Duration time.Duration      `json:"-"`
	// DevKeyID is the test signing key's ID; receivers never trust it.
	DevKeyID string `json:"dev_key_id,omitempty"`
}

// OK reports whether every job succeeded.
func (r *BuildResult) OK() bool {
	for _, j := range r.Jobs {
		if j.Status != engine.Succeeded {
			return false
		}
	}
	return true
}

type unitPlan struct {
	unit    string
	version string
	bc      *engine.BuildContext
	parts   []engine.Part
	names   []string // selected part names (nil = all)
}

func (a *App) normalizeBuild(req BuildRequest) (units []string, err error) {
	if req.Unit == "" {
		return nil, errors.New("no unit given")
	}
	if req.Unit == AllUnits {
		if req.Version != "" {
			return nil, errors.New("--version needs a single unit, not all")
		}
		for _, u := range a.cfg.Units() {
			if _, real := a.cfg.VersionFiles[u]; real {
				units = append(units, u)
			}
		}
		if len(units) == 0 {
			return nil, errors.New("no unit has any parts registered yet")
		}
		return units, nil
	}
	if err := a.unitKnown(req.Unit); err != nil {
		return nil, err
	}
	return []string{req.Unit}, nil
}

// Build builds units from a git ref into <out>/<unit>/<version>/ and signs
// their SHA256SUMS.txt with the local test key. It never needs a release
// secret and never publishes.
func (a *App) Build(ctx context.Context, req BuildRequest) (*BuildResult, error) {
	units, err := a.normalizeBuild(req)
	if err != nil {
		return nil, err
	}
	if len(req.Parts) > 0 && len(units) != 1 {
		return nil, errors.New("--parts needs a single unit")
	}
	ref := req.Ref
	if ref == "" {
		ref = "HEAD"
	}
	out := req.OutRoot
	if out == "" {
		out = a.cfg.OutRoot
	}
	a.emit.note("", "exporting %s", ref)
	srcDir, sha, err := a.eng.Export(ctx, ref)
	if err != nil {
		return nil, err
	}

	var plans []unitPlan
	for _, u := range units {
		ver := req.Version
		if ver == "" {
			v, err := a.cfg.DevVersion(ctx, a.cfg.Repo, u, sha)
			if err != nil {
				return nil, fmt.Errorf("%s: %w", u, err)
			}
			ver = v.String()
		} else if !publish.ValidSemver(ver) {
			return nil, fmt.Errorf("version %q is not strict semver (no leading v)", ver)
		}
		p := unitPlan{unit: u, version: ver, parts: a.cfg.Parts(u), names: req.Parts,
			bc: &engine.BuildContext{Engine: a.eng, Unit: u, Version: ver, Commit: sha, SrcDir: srcDir, OutRoot: out}}
		plans = append(plans, p)
	}
	res := &BuildResult{Commit: sha}
	runRes, err := a.runPlans(ctx, plans, req.Jobs, req.HeavyJobs, !req.NoFailFast)
	if runRes != nil {
		res.Jobs, res.Duration = runRes.Jobs, runRes.Duration
	}
	if err != nil {
		return res, err
	}
	if !runRes.OK() {
		return res, runRes.FirstError()
	}
	dev, derr := a.DevKey()
	if derr != nil {
		return res, fmt.Errorf("test signing key: %w", derr)
	}
	res.DevKeyID = dev.ID
	for _, p := range plans {
		ub, err := a.finishUnit(p, out, dev.Signer, len(req.Parts) == 0)
		if err != nil {
			return res, err
		}
		res.Units = append(res.Units, ub)
	}
	return res, nil
}

// runPlans builds every plan's graph (selected parts and their
// dependencies), merges them and runs the lot with one job pool.
func (a *App) runPlans(ctx context.Context, plans []unitPlan, jobs, heavy int, failFast bool) (*engine.Result, error) {
	if jobs <= 0 {
		jobs = runtime.NumCPU()
	}
	if heavy <= 0 {
		heavy = 2
	}
	merged := engine.NewGraph()
	for _, p := range plans {
		if len(p.parts) == 0 {
			return nil, fmt.Errorf("%s: no parts are registered for this unit yet", p.unit)
		}
		for _, n := range p.names {
			found := false
			var have []string
			for _, pt := range p.parts {
				have = append(have, pt.Name())
				found = found || pt.Name() == n
			}
			if !found {
				return nil, fmt.Errorf("%s has no part %q (have %s)", p.unit, n, strings.Join(have, ", "))
			}
		}
		g, err := engine.BuildGraph(p.bc, p.parts)
		if err != nil {
			return nil, fmt.Errorf("%s: %w", p.unit, err)
		}
		if len(p.names) > 0 {
			if g, err = selectParts(g, p.unit, p.names); err != nil {
				return nil, err
			}
		}
		for _, pt := range p.parts {
			if err := os.MkdirAll(p.bc.PartOutDir(pt.Name()), 0o755); err != nil {
				return nil, err
			}
		}
		if err := merged.Add(g.Jobs()...); err != nil {
			return nil, err
		}
	}
	if err := merged.Validate(); err != nil {
		return nil, err
	}
	return merged.Run(ctx, engine.Options{
		Jobs: jobs, HeavyJobs: heavy, FailFast: failFast,
		Engine: a.eng, Redactor: a.eng.Redactor,
		OnEvent: func(ev engine.Event) {
			unit, _, _ := strings.Cut(ev.Job, "/")
			a.emit.emit(Event{Kind: EventBuild, Unit: unit, Build: ev, Time: ev.Time})
		},
	})
}

// selectParts keeps the jobs of the named parts and everything they depend on.
func selectParts(g *engine.Graph, unit string, names []string) (*engine.Graph, error) {
	all := g.Jobs()
	byID := map[string]engine.Job{}
	for _, j := range all {
		byID[j.ID] = j
	}
	keep := map[string]bool{}
	var visit func(id string)
	visit = func(id string) {
		if keep[id] {
			return
		}
		keep[id] = true
		for _, d := range byID[id].Deps {
			visit(d)
		}
	}
	for _, j := range all {
		for _, n := range names {
			pre := unit + "/" + n
			if j.ID == pre || strings.HasPrefix(j.ID, pre+":") {
				visit(j.ID)
			}
		}
	}
	out := engine.NewGraph()
	for _, j := range all {
		if keep[j.ID] {
			if err := out.Add(j); err != nil {
				return nil, err
			}
		}
	}
	return out, nil
}

// finishUnit brings the deliverables up into the version dir and signs the sums.
func (a *App) finishUnit(p unitPlan, out string, signer publish.Signer, full bool) (UnitBuild, error) {
	dir := versionDir(out, p.unit, p.version)
	ub := UnitBuild{Unit: p.unit, Version: p.version, Dir: dir}
	missing, err := flatten(dir, a.cfg.FeedSpecs(p.unit))
	if err != nil {
		return ub, err
	}
	ub.Missing = missing
	names, err := publish.OutputFiles(dir)
	if err != nil {
		return ub, err
	}
	if len(names) == 0 {
		return ub, fmt.Errorf("%s: the build produced no files in %s", p.unit, dir)
	}
	files, err := publish.WriteSigned(dir, p.unit, p.version, signer)
	if err != nil {
		return ub, err
	}
	ub.Signed = true
	for _, n := range names {
		ub.Files = append(ub.Files, FileOut{Name: n, Size: files[n].Size, SHA256: files[n].SHA256})
	}
	return ub, nil
}

// ---- test signing key

// DevKey is the local test signing key used for dev builds and serve-dev.
// It is not in keys/ and no production receiver trusts it.
type DevKey struct {
	Signer publish.MinisignSigner
	Public minisign.PublicKey
	// ID is the key ID in the form minisign prints.
	ID string
	// Path is the private key file; the public key sits next to it as .pub.
	Path string
	// New is true when this call created the key.
	New bool
}

// PublicLine is the key as a single line (what Luna's update settings take).
func (k *DevKey) PublicLine() string {
	b, _ := k.Public.MarshalText()
	lines := strings.Split(strings.TrimSpace(string(b)), "\n")
	return lines[len(lines)-1]
}

// DevKey loads the test key from <cache>/dev-key, creating it on first use.
func (a *App) DevKey() (*DevKey, error) {
	path := filepath.Join(a.cfg.CacheDir, "dev-key")
	var priv minisign.PrivateKey
	var pub minisign.PublicKey
	created := false
	b, err := os.ReadFile(path)
	switch {
	case err == nil:
		if err := priv.UnmarshalText(bytes.TrimSpace(b)); err != nil {
			return nil, fmt.Errorf("%s: %w", path, err)
		}
		pub = priv.Public().(minisign.PublicKey)
	case errors.Is(err, os.ErrNotExist):
		pub, priv, err = minisign.GenerateKey(rand.Reader)
		if err != nil {
			return nil, err
		}
		pt, err := priv.MarshalText()
		if err != nil {
			return nil, err
		}
		if err := os.MkdirAll(a.cfg.CacheDir, 0o700); err != nil {
			return nil, err
		}
		if err := writeAtomic(path, append(pt, '\n'), 0o600); err != nil {
			return nil, err
		}
		created = true
	default:
		return nil, err
	}
	pubText, _ := pub.MarshalText()
	if err := writeAtomic(path+".pub", append(pubText, '\n'), 0o644); err != nil {
		return nil, err
	}
	return &DevKey{Signer: publish.MinisignSigner{Key: priv}, Public: pub, ID: fmt.Sprintf("%016X", priv.ID()), Path: path, New: created}, nil
}

func writeAtomic(path string, data []byte, perm os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

func gitShow(ctx context.Context, repo, sha, path string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", repo, "show", sha+":"+path)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git show %s:%s: %w: %s", shortSHA(sha), path, err, strings.TrimSpace(errb.String()))
	}
	return out.String(), nil
}

func shortSHA(s string) string {
	if len(s) > 12 {
		return s[:12]
	}
	return s
}

func sortedKeys[V any](m map[string]V) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
