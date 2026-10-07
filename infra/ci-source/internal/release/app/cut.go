package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/version"
)

// CutRequest is one `cut`.
type CutRequest struct {
	Unit    string
	Channel string // publish.Stable or publish.Beta
	// Bump is patch, minor, major or beta. Empty: beta for the beta channel,
	// patch for stable. Ignored when Version is set or a cut is resumed.
	Bump string
	// Version is an explicit version.
	Version string
	// Notes are the release notes (empty: a draft from commit subjects).
	Notes string
	// Resume continues an unfinished cut of this unit.
	Resume bool
	// Dry does everything locally and skips every network write.
	Dry             bool
	Jobs, HeavyJobs int
}

// Check is one preflight line.
type Check struct {
	Name   string `json:"name"`
	State  string `json:"state"` // ok, warn, fail
	Detail string `json:"detail"`
}

// Check states.
const (
	CheckOK   = "ok"
	CheckWarn = "warn"
	CheckFail = "fail"
)

// PreflightReport is everything checked before a cut starts.
type PreflightReport struct {
	Unit    string `json:"unit"`
	Channel string `json:"channel"`
	// Current is the unit's VERSION now; Version is what this cut produces.
	Current string  `json:"current"`
	Version string  `json:"version"`
	Checks  []Check `json:"checks"`
	// Secrets are the proven statuses the cut needs, for the fix-it screen.
	Secrets []secrets.Status `json:"secrets,omitempty"`
}

// OK reports whether no check failed.
func (r *PreflightReport) OK() bool {
	for _, c := range r.Checks {
		if c.State == CheckFail {
			return false
		}
	}
	return true
}

// PreflightError is returned by Cut when preflight fails.
type PreflightError struct{ Report *PreflightReport }

func (e *PreflightError) Error() string {
	var bad []string
	for _, c := range e.Report.Checks {
		if c.State == CheckFail {
			bad = append(bad, c.Name+": "+c.Detail)
		}
	}
	return "preflight failed: " + strings.Join(bad, "; ")
}

// CutResult is a finished cut.
type CutResult struct {
	Unit    string `json:"unit"`
	Version string `json:"version"`
	Channel string `json:"channel"`
	Dry     bool   `json:"dry_run"`
	SHA     string `json:"sha"`
	FeedSHA string `json:"feed_sha"`
	Tag     string `json:"tag"`
	// Files are the registry URLs, FeedURLs the feeds written, and OutDir the
	// local build output.
	Files    []string `json:"files"`
	FeedURLs []string `json:"feeds"`
	OutDir   string   `json:"out_dir"`
}

func validChannel(ch string) bool { return ch == publish.Stable || ch == publish.Beta }

// currentVersion reads the unit's VERSION from the working tree.
func (a *App) currentVersion(unit string) (version.Version, error) {
	rel, ok := a.cfg.VersionFiles[unit]
	if !ok {
		return version.Version{}, fmt.Errorf("unit %q has no VERSION file", unit)
	}
	return version.ReadFile(filepath.Join(a.cfg.Repo, rel))
}

func (a *App) stateDir() string {
	if a.cfg.StateDir != "" {
		return a.cfg.StateDir
	}
	d, _ := publish.DefaultStateDir()
	return d
}

// Unfinished returns saved cuts of unit that did not finish, newest first.
func (a *App) Unfinished(unit string) ([]publish.State, error) {
	m, err := filepath.Glob(filepath.Join(a.stateDir(), unit+"@*.json"))
	if err != nil {
		return nil, err
	}
	var out []publish.State
	for _, p := range m {
		b, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var st publish.State
		if json.Unmarshal(b, &st) != nil || st.Unit != unit {
			continue
		}
		done := true
		for _, s := range publish.Steps {
			done = done && st.Done[s]
		}
		if !done {
			out = append(out, st)
		}
	}
	return out, nil
}

// CutVersion works out the version a request produces and checks it against
// the channel. For a resume without an explicit version it is the version of
// the unfinished cut.
func (a *App) CutVersion(req CutRequest) (cur, next version.Version, err error) {
	if err := a.unitKnown(req.Unit); err != nil {
		return cur, next, err
	}
	if !validChannel(req.Channel) {
		return cur, next, fmt.Errorf("channel must be stable or beta, not %q", req.Channel)
	}
	cur, err = a.currentVersion(req.Unit)
	if err != nil {
		return cur, next, err
	}
	switch {
	case req.Version != "":
		next, err = version.Parse(req.Version)
		if err != nil {
			return cur, next, err
		}
	case req.Resume:
		un, err := a.Unfinished(req.Unit)
		if err != nil {
			return cur, next, err
		}
		if len(un) == 0 {
			return cur, next, fmt.Errorf("no unfinished cut of %s to resume", req.Unit)
		}
		if len(un) > 1 {
			return cur, next, fmt.Errorf("several unfinished cuts of %s; name the version to resume", req.Unit)
		}
		next, err = version.Parse(un[0].Version)
		if err != nil {
			return cur, next, err
		}
	default:
		kind := req.Bump
		if kind == "" {
			kind = version.BumpPatch
			if req.Channel == publish.Beta {
				kind = version.BumpBeta
			}
		}
		next, err = cur.Next(kind)
		if err != nil {
			return cur, next, err
		}
	}
	if req.Channel == publish.Stable && next.IsPrerelease() {
		return cur, next, fmt.Errorf("%s is a pre-release; stable needs a final version (use --bump patch)", next)
	}
	if req.Channel == publish.Beta {
		if _, ok := next.BetaNumber(); !ok {
			return cur, next, fmt.Errorf("%s is not a beta version (X.Y.Z-beta.N); use --bump beta", next)
		}
	}
	return cur, next, nil
}

// Preflight checks everything a cut needs before it starts: version, git,
// secrets (found and proven; missing ones are asked through the Prompter),
// and parts. Nothing is built or pushed.
func (a *App) Preflight(ctx context.Context, req CutRequest) *PreflightReport {
	rep := &PreflightReport{Unit: req.Unit, Channel: req.Channel}
	add := func(name, state, detail string) { rep.Checks = append(rep.Checks, Check{name, state, detail}) }

	cur, next, err := a.CutVersion(req)
	if err != nil {
		add("version", CheckFail, err.Error())
		return rep
	}
	rep.Current, rep.Version = cur.String(), next.String()
	if !req.Resume && next.Compare(cur) <= 0 {
		add("version", CheckFail, fmt.Sprintf("%s is not newer than the current %s", next, cur))
	} else {
		add("version", CheckOK, fmt.Sprintf("%s on %s (current %s)", next, req.Channel, cur))
	}
	if len(a.cfg.Parts(req.Unit)) == 0 {
		add("parts", CheckFail, "no parts are registered for "+req.Unit)
	} else {
		add("parts", CheckOK, fmt.Sprintf("%d parts", len(a.cfg.Parts(req.Unit))))
	}
	tag := publish.Tag(req.Unit, next.String())
	switch {
	case req.Dry:
		add("git", CheckOK, "dry run: works in a throwaway clone")
	case req.Resume:
		add("git", CheckOK, "resuming; the cut checks its own state")
	default:
		if err := (publish.Git{Dir: a.cfg.Repo}).Preflight(ctx, "main", tag, "origin", "forgejo"); err != nil {
			add("git", CheckFail, err.Error())
		} else {
			add("git", CheckOK, "main, clean, tag "+tag+" free")
		}
	}

	var need []secrets.ID
	if a.cfg.Signer == nil {
		need = append(need, signingID(req.Unit))
	}
	if !req.Dry && a.cfg.ForgeCreds == nil {
		need = append(need, secrets.ForgejoToken)
	}
	if req.Unit == "luna-android" {
		need = append(need, secrets.AndroidKeystore)
	}
	for _, id := range need {
		st := a.sec.Status(ctx, id)
		rep.Secrets = append(rep.Secrets, st)
		if st.State == secrets.Proven {
			add(st.Label, CheckOK, st.Summary)
		} else {
			add(st.Label, CheckFail, st.Summary)
		}
	}
	return rep
}

// Cut builds and publishes one release: preflight, then publish.Run with the
// build, signer and forge clients wired in. Progress goes out as events.
func (a *App) Cut(ctx context.Context, req CutRequest) (*CutResult, error) {
	rep := a.Preflight(ctx, req)
	for _, c := range rep.Checks {
		a.emit.emit(Event{Kind: EventNote, Unit: req.Unit, Message: fmt.Sprintf("preflight %s: %s %s", c.Name, c.State, c.Detail)})
	}
	if !rep.OK() {
		return nil, &PreflightError{rep}
	}
	_, next, _ := a.CutVersion(req)

	var signer publish.Signer = a.cfg.Signer
	if signer == nil {
		sg, _ := a.sec.Signing(ctx, signingID(req.Unit))
		if sg == nil {
			return nil, errors.New("signing key is not available")
		}
		signer = secretSigner{sg}
	}
	cfg := publish.Config{
		Release: publish.Release{Unit: req.Unit, Version: next.String(), Channel: req.Channel, Notes: req.Notes},
		Repo:    a.cfg.Repo,
		Owner:   a.cfg.Owner, RepoName: a.cfg.RepoName,
		Bump:     a.bumpFunc(req.Unit, next, a.cfg.Now()),
		Signer:   signer,
		StateDir: a.cfg.StateDir, Dry: req.Dry, Resume: req.Resume,
		PollEvery: a.cfg.PollEvery, PollTimeout: a.cfg.PollTimeout, Now: a.cfg.Now,
		Log: func(f string, args ...any) { a.emit.note(req.Unit, f, args...) },
		OnStep: func(step, phase string, err error) {
			a.emit.emit(Event{Kind: EventCut, Unit: req.Unit, Step: step, Phase: phase, Err: err})
		},
	}
	if cfg.Release.Notes == "" {
		cfg.Release.Notes, _ = a.DraftNotes(ctx, req.Unit)
	}
	if !req.Dry {
		creds := a.cfg.ForgeCreds
		if creds == nil {
			creds, _ = a.sec.Forgejo(ctx)
		}
		if creds == nil {
			return nil, errors.New("Forgejo token is not available")
		}
		cfg.Registry, cfg.Forge = a.registry(creds)
	}
	cfg.Build = a.cutBuild(req, next.String())
	cfg.Resolve = a.cutResolve(req)

	res, err := publish.Run(ctx, cfg)
	if err != nil {
		return nil, errors.New(a.Redact(err.Error()))
	}
	out := &CutResult{Unit: req.Unit, Version: next.String(), Channel: req.Channel, Dry: res.Dry,
		SHA: res.SHA, FeedSHA: res.FeedSHA, Tag: res.Tag, OutDir: res.OutDir}
	reg := &publish.Registry{BaseURL: a.cfg.ForgejoURL, Owner: a.cfg.Owner}
	for _, f := range res.Files {
		out.Files = append(out.Files, reg.FileURL(req.Unit, next.String(), f))
	}
	for _, ch := range res.Channels {
		out.FeedURLs = append(out.FeedURLs, a.feedURL(req.Unit, ch))
	}
	return out, nil
}

// cutBuild is publish.Config.Build: build exactly the release SHA.
func (a *App) cutBuild(req CutRequest, ver string) func(ctx context.Context, src publish.Source) (string, error) {
	return func(ctx context.Context, src publish.Source) (string, error) {
		srcDir, sha, err := engine.ExportSource(ctx, src.Repo, src.SHA, a.cfg.CacheDir)
		if err != nil {
			return "", err
		}
		root := filepath.Join(a.cfg.CacheDir, "cut-dist")
		dir := versionDir(root, req.Unit, ver)
		if err := os.RemoveAll(dir); err != nil { // nothing stale may be uploaded
			return "", err
		}
		plan := unitPlan{unit: req.Unit, version: ver, parts: a.cfg.Parts(req.Unit),
			bc: &engine.BuildContext{Engine: a.eng, Unit: req.Unit, Version: ver, Commit: sha, SrcDir: srcDir, OutRoot: root}}
		res, err := a.runPlans(ctx, []unitPlan{plan}, req.Jobs, req.HeavyJobs, true)
		if err != nil {
			return "", err
		}
		if !res.OK() {
			return "", res.FirstError()
		}
		if _, err := flatten(dir, a.cfg.FeedSpecs(req.Unit)); err != nil {
			return "", err
		}
		return dir, nil
	}
}

// cutResolve is publish.Config.Resolve.
func (a *App) cutResolve(req CutRequest) func(ctx context.Context, src publish.Source, outDir string) (publish.Resolved, error) {
	var once sync.Once
	var prior func(string) (publish.PartSpec, bool)
	return func(ctx context.Context, src publish.Source, outDir string) (publish.Resolved, error) {
		var r publish.Resolved
		specs := a.cfg.FeedSpecs(req.Unit)
		if len(specs) == 0 {
			names, err := publish.OutputFiles(outDir)
			if err != nil {
				return r, err
			}
			for _, n := range names {
				r.Parts = append(r.Parts, publish.PartSpec{Name: n, OS: "any", Arch: "any", File: n})
			}
			return r, nil
		}
		once.Do(func() { prior = a.priorPart(ctx, req.Unit) })
		var err error
		if r.Parts, err = resolveSpecs(req.Unit, req.Channel, outDir, specs, prior); err != nil {
			return r, err
		}
		if req.Unit == "luna" {
			if r.API, err = lunaAPI(ctx, src.Repo, src.SHA); err != nil {
				return r, err
			}
		}
		return r, nil
	}
}
