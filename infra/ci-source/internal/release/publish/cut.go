package publish

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/feed"
)

// Step names, in cut order.
const (
	StepBump   = "bump"   // bump commit pushed to origin
	StepBuild  = "build"  // exact release SHA built
	StepSign   = "sign"   // SHA256SUMS.txt + .minisig
	StepUpload = "upload" // files in the registry
	StepVerify = "verify" // re-downloaded and hashes match
	StepFeed   = "feed"   // feed commit pushed to origin
	StepMirror = "mirror" // Forgejo has the bump and feed commits
	StepTag    = "tag"    // tag pushed to Forgejo
)

// Steps lists the steps in order.
var Steps = []string{StepBump, StepBuild, StepSign, StepUpload, StepVerify, StepFeed, StepMirror, StepTag}

// Source tells the builder which commit to build and where it can be read.
// Repo is the user's checkout, or a throwaway clone in a dry run.
type Source struct {
	Repo string
	SHA  string
}

// Config is one cut.
type Config struct {
	Release Release // Published may be left empty: the cut fixes it at the feed step

	Repo     string // local checkout (clean, on Branch)
	Branch   string // default "main"
	Origin   string // default "origin"
	Forgejo  string // default "forgejo"
	Owner    string // Forgejo owner/organisation, for registry and API
	RepoName string // Forgejo repository name

	// Bump writes VERSION (+ the copies toolchains need) into dir and returns
	// the changed paths relative to dir.
	Bump func(dir string) ([]string, error)
	// Build builds src.SHA into a directory holding one file per part and
	// returns it. It is called again on resume if the directory is gone.
	Build func(ctx context.Context, src Source) (outDir string, err error)

	Signer   Signer
	Registry *Registry
	Forge    *Forgejo

	// StateDir defaults to ~/.cache/libreserv-release/cuts.
	StateDir string
	// Dry does everything locally and skips every network write: the bump
	// commit lands in a throwaway clone, nothing is uploaded or pushed, and
	// the feed files are written to <outDir>/dry-feeds.
	Dry bool
	// Resume continues an earlier cut of the same unit and version.
	Resume bool

	PollEvery   time.Duration // default 5s
	PollTimeout time.Duration // default 10m
	Now         func() time.Time
	Log         func(format string, args ...any)

	// test seams
	beforeStep  func(step string) error
	afterEffect func(step string) error
}

// Result is what a finished cut reports.
type Result struct {
	SHA      string
	FeedSHA  string
	Tag      string
	OutDir   string
	Files    []string // registry files, in upload order
	Channels []string // feeds written
	Dry      bool
}

// ErrCutExists is returned for a fresh cut when an unfinished one for the same
// unit and version is on disk: continue it with Resume.
var ErrCutExists = errors.New("an unfinished cut of this version exists (resume it)")

// State is the persisted progress of one cut, keyed by the release SHA.
type State struct {
	Schema    int             `json:"schema"`
	Unit      string          `json:"unit"`
	Version   string          `json:"version"`
	Channel   string          `json:"channel"`
	SHA       string          `json:"sha"`
	Published string          `json:"published,omitempty"`
	OutDir    string          `json:"out_dir,omitempty"`
	FeedSHA   string          `json:"feed_sha,omitempty"`
	Channels  []string        `json:"channels,omitempty"`
	Done      map[string]bool `json:"done"`
	Updated   string          `json:"updated"`
}

// DefaultStateDir is ~/.cache/libreserv-release/cuts (honouring XDG_CACHE_HOME).
func DefaultStateDir() (string, error) {
	d, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "libreserv-release", "cuts"), nil
}

// Tag is the release tag, <unit>/vX.Y.Z.
func Tag(unit, version string) string { return unit + "/v" + version }

// BumpSubject is the release commit subject.
func BumpSubject(unit, version string) string {
	return fmt.Sprintf("chore(release): %s %s", unit, version)
}

type cut struct {
	Config
	g         Git
	st        *State
	statePath string
	tmpDirs   []string
	src       Source // where SHA can be read
}

// Run performs the cut (or continues it). Every step is skipped when already
// recorded as done and is safe to repeat when it was interrupted halfway.
func Run(ctx context.Context, cfg Config) (*Result, error) {
	c := &cut{Config: cfg, g: Git{Dir: cfg.Repo}}
	c.defaults()
	defer func() {
		for _, d := range c.tmpDirs {
			os.RemoveAll(d)
		}
	}()
	rel := c.Release
	if !ValidSemver(rel.Version) {
		return nil, fmt.Errorf("version %q is not strict semver", rel.Version)
	}
	if c.Signer == nil || c.Build == nil || c.Bump == nil {
		return nil, errors.New("signer, build and bump are required")
	}
	if !c.Dry && (c.Registry == nil || c.Forge == nil) {
		return nil, errors.New("registry and forgejo clients are required (unless dry run)")
	}
	tag := Tag(rel.Unit, rel.Version)

	if !c.Dry {
		if existing, err := c.findState(); err != nil {
			return nil, err
		} else if existing != "" {
			if !c.Resume {
				return nil, fmt.Errorf("%s %s: %w", rel.Unit, rel.Version, ErrCutExists)
			}
			if err := c.loadState(existing); err != nil {
				return nil, err
			}
		} else if c.Resume {
			// Nothing saved: the bump step recovers its own commit, so a
			// resume without state is just a fresh run.
			c.logf("no saved state for %s %s; starting the cut", rel.Unit, rel.Version)
		}
	}
	if c.st == nil {
		if !c.Dry {
			// Fresh cut: the plan's preflight (state-free parts).
			if err := c.g.Preflight(ctx, c.Branch, tag, c.Origin, c.Forgejo); err != nil {
				if !c.Resume {
					return nil, fmt.Errorf("preflight: %w", err)
				}
			}
		}
		c.st = &State{Schema: 1, Unit: rel.Unit, Version: rel.Version, Channel: rel.Channel, Done: map[string]bool{}}
	}
	if c.st.Channel != rel.Channel {
		return nil, fmt.Errorf("saved cut is for channel %s, not %s", c.st.Channel, rel.Channel)
	}
	if c.st.Published != "" {
		c.Release.Published = c.st.Published
	}

	fns := map[string]func(context.Context) error{
		StepBump: c.stepBump, StepBuild: c.stepBuild, StepSign: c.stepSign, StepUpload: c.stepUpload,
		StepVerify: c.stepVerify, StepFeed: c.stepFeed, StepMirror: c.stepMirror, StepTag: c.stepTag,
	}
	for _, name := range Steps {
		if c.st.Done[name] {
			c.logf("%s: done earlier", name)
			continue
		}
		if c.beforeStep != nil {
			if err := c.beforeStep(name); err != nil {
				return nil, fmt.Errorf("%s: %w", name, err)
			}
		}
		c.logf("%s ...", name)
		if err := fns[name](ctx); err != nil {
			return nil, fmt.Errorf("%s: %w", name, err)
		}
		if c.afterEffect != nil {
			if err := c.afterEffect(name); err != nil {
				return nil, fmt.Errorf("%s: %w", name, err)
			}
		}
		c.st.Done[name] = true
		if err := c.save(); err != nil {
			return nil, err
		}
	}
	files, _ := c.uploadList()
	return &Result{SHA: c.st.SHA, FeedSHA: c.st.FeedSHA, Tag: tag, OutDir: c.st.OutDir,
		Files: files, Channels: c.st.Channels, Dry: c.Dry}, nil
}

func (c *cut) defaults() {
	if c.Branch == "" {
		c.Branch = "main"
	}
	if c.Origin == "" {
		c.Origin = "origin"
	}
	if c.Forgejo == "" {
		c.Forgejo = "forgejo"
	}
	if c.PollEvery == 0 {
		c.PollEvery = 5 * time.Second
	}
	if c.PollTimeout == 0 {
		c.PollTimeout = 10 * time.Minute
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Log == nil {
		c.Log = func(string, ...any) {}
	}
	if c.StateDir == "" {
		c.StateDir, _ = DefaultStateDir()
	}
}

func (c *cut) logf(f string, a ...any) { c.Log(f, a...) }

// --- state

func stateName(unit, version, sha string) string {
	return unit + "@" + version + "@" + sha[:12] + ".json"
}

// findState returns the path of an earlier cut of this unit and version.
func (c *cut) findState() (string, error) {
	m, err := filepath.Glob(filepath.Join(c.StateDir, c.Release.Unit+"@"+c.Release.Version+"@*.json"))
	if err != nil || len(m) == 0 {
		return "", err
	}
	if len(m) > 1 {
		return "", fmt.Errorf("several saved cuts of %s %s in %s; remove the stale ones", c.Release.Unit, c.Release.Version, c.StateDir)
	}
	return m[0], nil
}

func (c *cut) loadState(p string) error {
	b, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	var st State
	if err := json.Unmarshal(b, &st); err != nil {
		return fmt.Errorf("%s: %w", p, err)
	}
	if st.Done == nil {
		st.Done = map[string]bool{}
	}
	c.st, c.statePath = &st, p
	return nil
}

func (c *cut) save() error {
	if c.Dry || c.st.SHA == "" {
		return nil
	}
	c.st.Updated = c.Now().UTC().Format(feed.TimeLayout)
	if err := os.MkdirAll(c.StateDir, 0o700); err != nil {
		return err
	}
	p := filepath.Join(c.StateDir, stateName(c.st.Unit, c.st.Version, c.st.SHA))
	b, err := json.MarshalIndent(c.st, "", "  ")
	if err != nil {
		return err
	}
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, b, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tmp, p); err != nil {
		return err
	}
	c.statePath = p
	return nil
}

// --- steps

func (c *cut) stepBump(ctx context.Context) error {
	g := c.g
	rel := c.Release
	if c.Dry {
		tmp, err := os.MkdirTemp("", "libreserv-dry-")
		if err != nil {
			return err
		}
		c.tmpDirs = append(c.tmpDirs, tmp)
		clone := filepath.Join(tmp, "repo")
		if _, err := g.run(ctx, "clone", "--quiet", "--branch", c.Branch, c.Repo, clone); err != nil {
			return err
		}
		g = Git{Dir: clone}
	}
	sha, err := g.Bump(ctx, c.Origin, c.Branch, BumpSubject(rel.Unit, rel.Version), !c.Dry, c.Bump)
	if err != nil {
		return err
	}
	c.st.SHA = sha
	if err := c.save(); err != nil { // the SHA names the state file
		return err
	}
	c.src = Source{Repo: g.Dir, SHA: sha}
	return nil
}

// source is where the release SHA can be read (the checkout, or the dry clone).
func (c *cut) source(ctx context.Context) (Source, error) {
	if c.src.SHA == c.st.SHA && c.src.Repo != "" {
		return c.src, nil
	}
	if !c.g.HasCommit(ctx, c.st.SHA) {
		if _, err := c.g.run(ctx, "fetch", "--quiet", c.Origin, c.Branch); err != nil || !c.g.HasCommit(ctx, c.st.SHA) {
			return Source{}, fmt.Errorf("release commit %s is not in %s", c.st.SHA, c.Repo)
		}
	}
	c.src = Source{Repo: c.Repo, SHA: c.st.SHA}
	return c.src, nil
}

func (c *cut) stepBuild(ctx context.Context) error {
	src, err := c.source(ctx)
	if err != nil {
		return err
	}
	out, err := c.Build(ctx, src)
	if err != nil {
		return err
	}
	for _, p := range c.Release.Parts {
		if p.Version != "" {
			continue
		}
		if _, err := os.Stat(filepath.Join(out, p.File)); err != nil {
			return fmt.Errorf("build did not produce %s: %w", p.File, err)
		}
	}
	c.st.OutDir = out
	return nil
}

// outDir returns the build output, rebuilding if it vanished since an earlier run.
func (c *cut) outDir(ctx context.Context) (string, error) {
	if c.st.OutDir != "" {
		if _, err := os.Stat(c.st.OutDir); err == nil {
			return c.st.OutDir, nil
		}
		c.logf("build output %s is gone; building again", c.st.OutDir)
	}
	if err := c.stepBuild(ctx); err != nil {
		return "", err
	}
	if _, err := WriteSigned(c.st.OutDir, c.Release.Unit, c.Release.Version, c.Signer); err != nil {
		return "", err
	}
	return c.st.OutDir, c.save()
}

func (c *cut) stepSign(ctx context.Context) error {
	dir, err := c.outDir(ctx)
	if err != nil {
		return err
	}
	_, err = WriteSigned(dir, c.Release.Unit, c.Release.Version, c.Signer)
	return err
}

// uploadList is every registry file, parts first and the sums last.
func (c *cut) uploadList() ([]string, error) {
	if c.st.OutDir == "" {
		return nil, nil
	}
	names, err := OutputFiles(c.st.OutDir)
	if err != nil {
		return nil, err
	}
	return append(names, SumsName, SumsSigName), nil
}

func (c *cut) stepUpload(ctx context.Context) error {
	dir, err := c.outDir(ctx)
	if err != nil {
		return err
	}
	files, err := c.uploadList()
	if err != nil {
		return err
	}
	for _, f := range files {
		if c.Dry {
			c.logf("dry run: would upload %s", f)
			continue
		}
		res, err := c.Registry.Upload(ctx, c.Release.Unit, c.Release.Version, f, filepath.Join(dir, f))
		if err != nil {
			return err
		}
		if res.Existed {
			c.logf("%s was already uploaded", f)
		}
	}
	return nil
}

func (c *cut) stepVerify(ctx context.Context) error {
	if c.Dry {
		return nil
	}
	dir, err := c.outDir(ctx)
	if err != nil {
		return err
	}
	files, err := c.uploadList()
	if err != nil {
		return err
	}
	for _, f := range files {
		want, err := HashFile(filepath.Join(dir, f))
		if err != nil {
			return err
		}
		if err := c.Registry.Check(ctx, c.Release.Unit, c.Release.Version, f, want); err != nil {
			return err
		}
	}
	return nil
}

func (c *cut) urlFor(version, file string) string {
	if c.Registry != nil {
		return c.Registry.FileURL(c.Release.Unit, version, file)
	}
	return fmt.Sprintf("https://dry-run.invalid/%s/%s/%s", c.Release.Unit, version, file)
}

func (c *cut) stepFeed(ctx context.Context) error {
	dir, err := c.outDir(ctx)
	if err != nil {
		return err
	}
	_, files, err := Sums(dir)
	if err != nil {
		return err
	}
	if c.st.Published == "" {
		c.st.Published = c.Now().UTC().Format(feed.TimeLayout)
		if err := c.save(); err != nil {
			return err
		}
	}
	c.Release.Published = c.st.Published
	rel := c.Release

	var channels []string
	plan := func(read func(string) ([]byte, error)) ([]FeedFile, error) {
		outs, err := PlanFeeds(rel, files, c.urlFor, func(ch string) (*feed.Feed, error) {
			b, err := read(FeedPath(rel.Unit, ch))
			if err != nil || b == nil {
				return nil, err
			}
			var f feed.Feed
			if err := json.Unmarshal(b, &f); err != nil {
				return nil, fmt.Errorf("existing %s feed: %w", ch, err)
			}
			return &f, nil
		})
		if err != nil {
			return nil, err
		}
		channels = channels[:0]
		for _, o := range outs {
			channels = append(channels, o.Channel)
		}
		return SignFeeds(outs, c.Signer)
	}
	msg := fmt.Sprintf("feed: %s %s (%s)", rel.Unit, rel.Version, strings.Join([]string{rel.Channel}, ","))
	sha, written, err := c.g.CommitFeeds(ctx, c.Origin, "feeds", msg, !c.Dry, plan)
	if err != nil {
		return err
	}
	c.st.FeedSHA, c.st.Channels = sha, append([]string(nil), channels...)
	if c.Dry {
		for _, f := range written {
			p := filepath.Join(dir, "dry-feeds", filepath.FromSlash(f.Path))
			if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
				return err
			}
			if err := os.WriteFile(p, f.Data, 0o644); err != nil {
				return err
			}
		}
	}
	return nil
}

func (c *cut) stepMirror(ctx context.Context) error {
	if c.Dry {
		c.logf("dry run: not waiting for the mirror")
		return nil
	}
	goal := MirrorGoal{Unit: c.Release.Unit, Commits: []string{c.st.SHA, c.st.FeedSHA}, Published: map[string]string{}}
	for _, ch := range c.st.Channels {
		goal.Published[ch] = c.st.Published
	}
	return c.Forge.WaitMirror(ctx, goal, c.PollEvery, c.PollTimeout)
}

func (c *cut) stepTag(ctx context.Context) error {
	if c.Dry {
		c.logf("dry run: would push tag %s", Tag(c.Release.Unit, c.Release.Version))
		return nil
	}
	if _, err := c.source(ctx); err != nil {
		return err
	}
	return c.g.PushTag(ctx, c.Forgejo, Tag(c.Release.Unit, c.Release.Version), c.st.SHA)
}
