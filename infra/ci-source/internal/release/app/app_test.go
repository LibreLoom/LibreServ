package app

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"aead.dev/minisign"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/version"
)

// fakePart is a test-only part: it writes one file per part and can fail.
type fakePart struct {
	name string
	deps []string
	fail *int // fail while > 0, decrementing
	mu   *sync.Mutex
}

func (p fakePart) Name() string { return p.name }
func (fakePart) Unit() string   { return "fake" }
func (p fakePart) Jobs(b *engine.BuildContext) ([]engine.Job, error) {
	var deps []string
	for _, d := range p.deps {
		deps = append(deps, "fake/"+d)
	}
	return []engine.Job{{ID: "fake/" + p.name, Deps: deps, Run: func(ctx context.Context, j *engine.JobRun) error {
		if p.fail != nil {
			p.mu.Lock()
			f := *p.fail > 0
			if f {
				*p.fail--
			}
			p.mu.Unlock()
			if f {
				return errors.New("injected build failure")
			}
		}
		j.Logf("building %s %s", p.name, b.Version)
		ver, err := os.ReadFile(filepath.Join(b.SrcDir, "fake", "VERSION"))
		if err != nil {
			return err
		}
		body := fmt.Sprintf("%s built at %s from VERSION %s", p.name, b.Commit[:8], strings.TrimSpace(string(ver)))
		return os.WriteFile(filepath.Join(b.PartOutDir(p.name), "fake-"+p.name+".bin"), []byte(body), 0o644)
	}}}, nil
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

func gitEnv(t *testing.T) {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", "/dev/null")
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Test")
	t.Setenv("GIT_AUTHOR_EMAIL", "t@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Test")
	t.Setenv("GIT_COMMITTER_EMAIL", "t@example.invalid")
}

type world struct {
	t       *testing.T
	root    string
	repo    string
	origin  string
	forgejo string
	srv     *httptest.Server
	app     *App
	signer  publish.MinisignSigner
	pub     minisign.PublicKey
	events  []Event
	evMu    sync.Mutex
	failN   int
	files   map[string][]byte
	filesMu sync.Mutex
	polls   int
}

const fakeToken = "fake-token-1234567890"

func newWorld(t *testing.T) *world {
	t.Helper()
	gitEnv(t)
	w := &world{t: t, root: t.TempDir(), files: map[string][]byte{}}
	w.origin = filepath.Join(w.root, "origin.git")
	w.forgejo = filepath.Join(w.root, "forgejo.git")
	git(t, w.root, "init", "-q", "--bare", "-b", "main", w.origin)
	git(t, w.root, "init", "-q", "--bare", "-b", "main", w.forgejo)
	w.repo = filepath.Join(w.root, "repo")
	git(t, w.root, "clone", "-q", w.origin, w.repo)
	git(t, w.repo, "checkout", "-q", "-B", "main")
	must(t, os.MkdirAll(filepath.Join(w.repo, "fake"), 0o755))
	must(t, os.MkdirAll(filepath.Join(w.repo, "keys"), 0o755))
	must(t, os.WriteFile(filepath.Join(w.repo, "fake", "VERSION"), []byte("0.3.0\n"), 0o644))
	pub, priv, err := minisign.GenerateKey(rand.Reader)
	must(t, err)
	w.pub, w.signer = pub, publish.MinisignSigner{Key: priv}
	pt, _ := pub.MarshalText()
	must(t, os.WriteFile(filepath.Join(w.repo, "keys", "lsluna.minisign.pub"), []byte("untrusted comment: test key\n"+string(pt)+"\n"), 0o644))
	git(t, w.repo, "add", ".")
	git(t, w.repo, "commit", "-q", "-m", "init")
	git(t, w.repo, "push", "-q", "origin", "main")
	git(t, w.repo, "remote", "add", "forgejo", w.forgejo)

	mux := http.NewServeMux()
	mux.HandleFunc("/api/packages/", func(rw http.ResponseWriter, r *http.Request) {
		w.filesMu.Lock()
		defer w.filesMu.Unlock()
		switch r.Method {
		case http.MethodPut:
			if r.Header.Get("Authorization") != "token "+fakeToken {
				http.Error(rw, "no", 401)
				return
			}
			if _, ok := w.files[r.URL.Path]; ok {
				http.Error(rw, "exists", 409)
				return
			}
			b, _ := io.ReadAll(r.Body)
			w.files[r.URL.Path] = b
			rw.WriteHeader(201)
		case http.MethodGet:
			b, ok := w.files[r.URL.Path]
			if !ok {
				http.NotFound(rw, r)
				return
			}
			rw.Write(b)
		}
	})
	mux.HandleFunc("/api/v1/repos/LibreLoom/LibreServ/git/commits/", func(rw http.ResponseWriter, r *http.Request) {
		w.polls++
		if out, err := exec.Command("git", "-C", w.forgejo, "fetch", "-q", w.origin, "+refs/heads/*:refs/heads/*").CombinedOutput(); err != nil {
			t.Errorf("mirror: %v %s", err, out)
		}
		sha := filepath.Base(r.URL.Path)
		if exec.Command("git", "-C", w.forgejo, "cat-file", "-e", sha+"^{commit}").Run() != nil {
			http.NotFound(rw, r)
			return
		}
		fmt.Fprintf(rw, `{"sha":%q}`, sha)
	})
	mux.HandleFunc("/LibreLoom/LibreServ/raw/branch/feeds/", func(rw http.ResponseWriter, r *http.Request) {
		rel := strings.TrimPrefix(r.URL.Path, "/LibreLoom/LibreServ/raw/branch/feeds/")
		out, err := exec.Command("git", "-C", w.forgejo, "show", "feeds:"+rel).Output()
		if err != nil {
			http.NotFound(rw, r)
			return
		}
		rw.Write(out)
	})
	w.srv = httptest.NewServer(mux)
	t.Cleanup(w.srv.Close)

	eng, err := engine.New(engine.Config{Repo: w.repo, CacheDir: filepath.Join(w.root, "cache")})
	must(t, err)
	fails := &w.failN
	mu := &sync.Mutex{}
	w.app, err = New(Config{
		Repo: w.repo, Engine: eng, OutRoot: filepath.Join(w.root, "dist"),
		Secrets: secrets.New(secrets.Options{RepoRoot: w.repo, Home: w.root, NoHomeScan: true, Getenv: func(string) string { return "" }}),
		Parts: func(unit string) []engine.Part {
			if unit != "fake" {
				return nil
			}
			return []engine.Part{fakePart{name: "web"}, fakePart{name: "server", deps: []string{"web"}, fail: fails, mu: mu}}
		},
		Units:        func() []string { return []string{"fake"} },
		FeedSpecs:    func(string) []FileSpec { return nil },
		VersionFiles: map[string]string{"fake": "fake/VERSION"},
		DevVersion: func(ctx context.Context, repo, unit, ref string) (version.Version, error) {
			return version.Dev(version.MustParse("0.3.0"), 7), nil
		},
		Signer:     w.signer,
		ForgeCreds: &secrets.ForgejoCreds{BaseURL: w.srv.URL, Token: fakeToken, User: "tester"},
		ForgejoURL: w.srv.URL,
		StateDir:   filepath.Join(w.root, "cuts"),
		PollEvery:  time.Millisecond, PollTimeout: 5 * time.Second,
		Now: func() time.Time { return time.Date(2026, 10, 12, 14, 3, 0, 0, time.UTC) },
		OnEvent: func(ev Event) {
			w.evMu.Lock()
			w.events = append(w.events, ev)
			w.evMu.Unlock()
		},
	})
	must(t, err)
	return w
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestBuildFlattensAndSignsWithDevKey(t *testing.T) {
	w := newWorld(t)
	res, err := w.app.Build(context.Background(), BuildRequest{Unit: "fake", Jobs: 2})
	must(t, err)
	if len(res.Units) != 1 || res.Units[0].Version != "0.3.1-0.dev.7" {
		t.Fatalf("units %+v", res.Units)
	}
	u := res.Units[0]
	want := filepath.Join(w.root, "dist", "fake", "0.3.1-0.dev.7")
	if u.Dir != want {
		t.Fatalf("dir %s want %s", u.Dir, want)
	}
	if len(u.Files) != 2 || u.Files[0].Name != "fake-server.bin" || u.Files[1].Name != "fake-web.bin" {
		t.Fatalf("files %+v", u.Files)
	}
	body, _ := os.ReadFile(filepath.Join(want, "fake-server.bin"))
	if !strings.Contains(string(body), "VERSION 0.3.0") {
		t.Fatalf("built from wrong tree: %s", body)
	}
	sums, _ := os.ReadFile(filepath.Join(want, publish.SumsName))
	sig, _ := os.ReadFile(filepath.Join(want, publish.SumsSigName))
	dev, err := w.app.DevKey()
	must(t, err)
	if !minisign.Verify(dev.Public, sums, sig) {
		t.Fatal("sums not signed by the dev key")
	}
	if dev.New {
		t.Fatal("second DevKey call must reuse the key")
	}
	// the dev key is not any key under keys/
	if dev.Public.ID() == w.pub.ID() {
		t.Fatal("dev key equals the production test key")
	}
	if !strings.HasPrefix(dev.Path, filepath.Join(w.root, "cache")) {
		t.Fatalf("dev key outside the cache: %s", dev.Path)
	}
	if res.DevKeyID != dev.ID {
		t.Fatal("result lacks the dev key id")
	}
	// events: queued/started/finished for both jobs, in one stream
	w.evMu.Lock()
	defer w.evMu.Unlock()
	started := 0
	for _, ev := range w.events {
		if ev.Kind == EventBuild && ev.Build.Type == engine.EventStarted {
			started++
		}
	}
	if started != 2 {
		t.Fatalf("started events %d", started)
	}
}

func TestBuildPartsClosureAndErrors(t *testing.T) {
	w := newWorld(t)
	// "server" depends on "web": selecting it builds both
	res, err := w.app.Build(context.Background(), BuildRequest{Unit: "fake", Parts: []string{"server"}})
	must(t, err)
	if len(res.Jobs) != 2 {
		t.Fatalf("jobs %+v", res.Jobs)
	}
	// "web" alone builds one
	res, err = w.app.Build(context.Background(), BuildRequest{Unit: "fake", Parts: []string{"web"}, Version: "9.9.9"})
	must(t, err)
	if len(res.Jobs) != 1 || res.Units[0].Version != "9.9.9" {
		t.Fatalf("jobs %+v units %+v", res.Jobs, res.Units)
	}
	if _, err := w.app.Build(context.Background(), BuildRequest{Unit: "fake", Parts: []string{"nope"}}); err == nil || !strings.Contains(err.Error(), "no part") {
		t.Fatalf("unknown part: %v", err)
	}
	if _, err := w.app.Build(context.Background(), BuildRequest{Unit: "nope"}); err == nil || !strings.Contains(err.Error(), "unknown unit") {
		t.Fatalf("unknown unit: %v", err)
	}
	if _, err := w.app.Build(context.Background(), BuildRequest{Unit: "fake", Version: "v1.0.0"}); err == nil {
		t.Fatal("v-prefixed version accepted")
	}
	if _, err := w.app.Build(context.Background(), BuildRequest{Unit: AllUnits, Version: "1.0.0"}); err == nil {
		t.Fatal("--version with all accepted")
	}
	// "all" skips units without a VERSION file (the demo unit)
	w.app.cfg.Units = func() []string { return []string{"fake", "demo"} }
	res, err = w.app.Build(context.Background(), BuildRequest{Unit: AllUnits})
	must(t, err)
	if len(res.Units) != 1 {
		t.Fatalf("all built %d units", len(res.Units))
	}
}

func TestBuildFailureKeepsResult(t *testing.T) {
	w := newWorld(t)
	w.failN = 1
	res, err := w.app.Build(context.Background(), BuildRequest{Unit: "fake"})
	if err == nil || !strings.Contains(err.Error(), "injected") {
		t.Fatalf("want build failure, got %v", err)
	}
	if res == nil || res.OK() || len(res.Units) != 0 {
		t.Fatalf("result %+v", res)
	}
}

func TestCutVersion(t *testing.T) {
	w := newWorld(t)
	cases := []struct {
		req  CutRequest
		want string
		bad  string
	}{
		{CutRequest{Unit: "fake", Channel: "stable"}, "0.3.1", ""},
		{CutRequest{Unit: "fake", Channel: "stable", Bump: "minor"}, "0.4.0", ""},
		{CutRequest{Unit: "fake", Channel: "beta"}, "0.3.1-beta.1", ""},
		{CutRequest{Unit: "fake", Channel: "beta", Bump: "patch"}, "", "not a beta version"},
		{CutRequest{Unit: "fake", Channel: "stable", Bump: "beta"}, "", "pre-release"},
		{CutRequest{Unit: "fake", Channel: "stable", Version: "1.0.0"}, "1.0.0", ""},
		{CutRequest{Unit: "fake", Channel: "stable", Version: "v1.0.0"}, "", "v1.0.0"},
		{CutRequest{Unit: "fake", Channel: "nightly"}, "", "channel"},
		{CutRequest{Unit: "other", Channel: "stable"}, "", "unknown unit"},
		{CutRequest{Unit: "fake", Channel: "stable", Resume: true}, "", "no unfinished cut"},
	}
	for _, c := range cases {
		_, next, err := w.app.CutVersion(c.req)
		if c.bad != "" {
			if err == nil || !strings.Contains(err.Error(), c.bad) {
				t.Errorf("%+v: err %v, want %q", c.req, err, c.bad)
			}
			continue
		}
		if err != nil || next.String() != c.want {
			t.Errorf("%+v: %v %v, want %s", c.req, next, err, c.want)
		}
	}
}

func TestPreflightReportsProblems(t *testing.T) {
	w := newWorld(t)
	rep := w.app.Preflight(context.Background(), CutRequest{Unit: "fake", Channel: "stable", Version: "0.2.0"})
	if rep.OK() {
		t.Fatal("older version passed")
	}
	// dirty tree
	must(t, os.WriteFile(filepath.Join(w.repo, "keys", "extra.txt"), []byte("x"), 0o644))
	git(t, w.repo, "add", "keys/extra.txt")
	rep = w.app.Preflight(context.Background(), CutRequest{Unit: "fake", Channel: "stable"})
	if rep.OK() {
		t.Fatalf("dirty tree passed: %+v", rep.Checks)
	}
	var git string
	for _, c := range rep.Checks {
		if c.Name == "git" {
			git = c.State
		}
	}
	if git != CheckFail {
		t.Fatalf("git check %q", git)
	}
	if _, err := w.app.Cut(context.Background(), CutRequest{Unit: "fake", Channel: "stable"}); err == nil {
		t.Fatal("cut ran with a dirty tree")
	} else {
		var pe *PreflightError
		if !errors.As(err, &pe) {
			t.Fatalf("want PreflightError, got %v", err)
		}
	}
}

func TestCutAndVerifyEndToEnd(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	res, err := w.app.Cut(ctx, CutRequest{Unit: "fake", Channel: "stable", Notes: "hello"})
	must(t, err)
	if res.Version != "0.3.1" || res.Tag != "fake/v0.3.1" || res.SHA == "" || res.FeedSHA == "" {
		t.Fatalf("result %+v", res)
	}
	if got := git(t, w.origin, "log", "-1", "--format=%s", "main"); got != "chore(release): fake 0.3.1" {
		t.Fatalf("subject %q", got)
	}
	if got := git(t, w.origin, "show", "main:fake/VERSION"); got != "0.3.1" {
		t.Fatalf("VERSION on origin %q", got)
	}
	if got := git(t, w.forgejo, "rev-parse", "fake/v0.3.1^{commit}"); got != res.SHA {
		t.Fatalf("tag at %s, release %s", got, res.SHA)
	}
	if len(res.Files) != 4 || !strings.HasSuffix(res.Files[0], "/generic/fake/0.3.1/fake-server.bin") {
		t.Fatalf("files %v", res.Files)
	}
	if len(res.FeedURLs) != 2 {
		t.Fatalf("feeds %v", res.FeedURLs)
	}
	// the built SHA is the release SHA: the part read VERSION 0.3.1
	w.filesMu.Lock()
	body := string(w.files["/api/packages/LibreLoom/generic/fake/0.3.1/fake-web.bin"])
	w.filesMu.Unlock()
	if !strings.Contains(body, res.SHA[:8]) || !strings.Contains(body, "VERSION 0.3.1") {
		t.Fatalf("uploaded file %q", body)
	}
	// every cut step emitted start+done, in order
	w.evMu.Lock()
	var seq []string
	for _, ev := range w.events {
		if ev.Kind == EventCut && ev.Phase == PhaseDone {
			seq = append(seq, ev.Step)
		}
	}
	w.evMu.Unlock()
	if strings.Join(seq, ",") != strings.Join(publish.Steps, ",") {
		t.Fatalf("cut steps %v", seq)
	}
	// verify against the live feed with the key from keys/
	vs, err := w.app.Verify(ctx, "fake", "")
	must(t, err)
	if len(vs) != 2 {
		t.Fatalf("verifications %+v", vs)
	}
	for _, v := range vs {
		if !v.OK() || v.Feed.Version != "0.3.1" {
			t.Fatalf("verify %s: %v", v.Channel, v.Err)
		}
	}
	// a second cut of the same version is refused
	git(t, w.repo, "pull", "-q", "origin", "main")
	if _, err := w.app.Cut(ctx, CutRequest{Unit: "fake", Channel: "stable", Version: "0.3.1"}); err == nil {
		t.Fatal("repeat cut accepted")
	}
}

func TestCutResumeAfterBuildFailure(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	w.failN = 1
	_, err := w.app.Cut(ctx, CutRequest{Unit: "fake", Channel: "beta"})
	if err == nil || !strings.Contains(err.Error(), "injected") {
		t.Fatalf("want build failure, got %v", err)
	}
	un, err := w.app.Unfinished("fake")
	must(t, err)
	if len(un) != 1 || un[0].Version != "0.3.1-beta.1" || !un[0].Done[publish.StepBump] || un[0].Done[publish.StepBuild] {
		t.Fatalf("unfinished %+v", un)
	}
	// the bump is on origin already; resume builds that SHA and finishes
	res, err := w.app.Cut(ctx, CutRequest{Unit: "fake", Channel: "beta", Resume: true})
	must(t, err)
	if res.Version != "0.3.1-beta.1" || res.SHA != un[0].SHA {
		t.Fatalf("resume result %+v (bump was %s)", res, un[0].SHA)
	}
	if got := git(t, w.forgejo, "tag", "--list"); got != "fake/v0.3.1-beta.1" {
		t.Fatalf("tags %q", got)
	}
	if un, _ := w.app.Unfinished("fake"); len(un) != 0 {
		t.Fatalf("still unfinished: %+v", un)
	}
	// beta cut writes only the beta feed
	if len(res.FeedURLs) != 1 || !strings.HasSuffix(res.FeedURLs[0], "/fake/beta.json") {
		t.Fatalf("feeds %v", res.FeedURLs)
	}
}

func TestDryCutPushesNothing(t *testing.T) {
	w := newWorld(t)
	before := git(t, w.origin, "rev-parse", "main")
	res, err := w.app.Cut(context.Background(), CutRequest{Unit: "fake", Channel: "stable", Dry: true})
	must(t, err)
	if !res.Dry || git(t, w.origin, "rev-parse", "main") != before {
		t.Fatal("dry run pushed")
	}
	if git(t, w.forgejo, "tag", "--list") != "" || len(w.files) != 0 {
		t.Fatal("dry run published")
	}
	if _, err := os.Stat(filepath.Join(res.OutDir, "dry-feeds", "fake", "stable.json")); err != nil {
		t.Fatal(err)
	}
	if got := git(t, w.repo, "status", "--porcelain"); got != "" {
		t.Fatalf("dry run dirtied the checkout: %s", got)
	}
}

func TestBumpFiles(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, s string) {
		must(t, os.MkdirAll(filepath.Dir(filepath.Join(dir, rel)), 0o755))
		must(t, os.WriteFile(filepath.Join(dir, rel), []byte(s), 0o644))
	}
	write(androidGradle, "android {\n    defaultConfig {\n        versionCode = 7\n        versionName = \"0.1.6\"\n    }\n}\n")
	write(desktopInfo, "<component>\n  <releases>\n    <release version=\"0.4.0\" date=\"2026-10-05\"/>\n  </releases>\n</component>\n")
	a := &App{cfg: Config{VersionFiles: version.Units}}
	now := time.Date(2026, 10, 12, 1, 0, 0, 0, time.UTC)

	for i := 0; i < 2; i++ { // twice: a rebase retry applies it again
		changed, err := a.bumpFunc("luna-android", version.MustParse("0.2.0-beta.3"), now)(dir)
		must(t, err)
		if len(changed) != 2 || changed[0] != "luna/mobile/VERSION" {
			t.Fatalf("changed %v", changed)
		}
		g, _ := os.ReadFile(filepath.Join(dir, androidGradle))
		// (0*10000+2*100+0)*100+3 = 20003
		if !strings.Contains(string(g), "versionCode = 20003\n") || !strings.Contains(string(g), `versionName = "0.2.0-beta.3"`) {
			t.Fatalf("gradle:\n%s", g)
		}
		if v, _ := os.ReadFile(filepath.Join(dir, "luna/mobile/VERSION")); string(v) != "0.2.0-beta.3\n" {
			t.Fatalf("VERSION %q", v)
		}
	}
	for i := 0; i < 2; i++ {
		_, err := a.bumpFunc("luna-desktop", version.MustParse("0.5.0"), now)(dir)
		must(t, err)
		x, _ := os.ReadFile(filepath.Join(dir, desktopInfo))
		want := "  <releases>\n    <release version=\"0.5.0\" date=\"2026-10-12\"/>\n    <release version=\"0.4.0\""
		if !strings.Contains(string(x), want) || strings.Count(string(x), `version="0.5.0"`) != 1 {
			t.Fatalf("metainfo:\n%s", x)
		}
	}
	// dev versions have no versionCode
	if _, err := a.bumpFunc("luna-android", version.MustParse("0.2.0-0.dev.3"), now)(dir); err == nil {
		t.Fatal("dev version accepted for android")
	}
	// a gradle file without exactly one literal each is refused
	write(androidGradle, "versionCode = 1\nversionCode = 2\nversionName = \"x\"\n")
	if _, err := a.bumpFunc("luna-android", version.MustParse("0.2.0"), now)(dir); err == nil {
		t.Fatal("ambiguous gradle accepted")
	}
}

func TestResolveSpecs(t *testing.T) {
	dir := t.TempDir()
	for _, f := range []string{"lunad-linux-amd64-musl"} {
		must(t, os.WriteFile(filepath.Join(dir, f), []byte("x"), 0o644))
	}
	specs := DefaultFileSpecs("luna")
	reused := func(name string) (publish.PartSpec, bool) {
		return publish.PartSpec{Version: "0.3.0", Size: 5, SHA256: "ab"}, true
	}
	parts, err := resolveSpecs("luna", "stable", dir, specs, reused)
	must(t, err)
	if len(parts) != 3 || parts[0].Version != "" || parts[1].Version != "0.3.0" || parts[1].File != "luna-os-x86_64.img.xz" {
		t.Fatalf("parts %+v", parts)
	}
	if _, err := resolveSpecs("luna", "stable", dir, specs, func(string) (publish.PartSpec, bool) { return publish.PartSpec{}, false }); err == nil || !strings.Contains(err.Error(), "no earlier release") {
		t.Fatalf("no prior: %v", err)
	}
	// a missing non-reusable file is an error
	if _, err := resolveSpecs("sol", "stable", dir, DefaultFileSpecs("sol"), nil); err == nil || !strings.Contains(err.Error(), "sol-linux-amd64") {
		t.Fatalf("missing: %v", err)
	}
	// desktop: a beta cut needs only the beta flatpak and the installer
	must(t, os.WriteFile(filepath.Join(dir, "luna-desktop-beta-x86_64.flatpak"), []byte("x"), 0o644))
	must(t, os.WriteFile(filepath.Join(dir, "Luna-Desktop-Setup-x86_64.exe"), []byte("x"), 0o644))
	parts, err = resolveSpecs("luna-desktop", "beta", dir, DefaultFileSpecs("luna-desktop"), nil)
	must(t, err)
	if len(parts) != 2 {
		t.Fatalf("desktop beta parts %+v", parts)
	}
	// a stable cut also feeds beta, so it needs both bundles
	if _, err := resolveSpecs("luna-desktop", "stable", dir, DefaultFileSpecs("luna-desktop"), nil); err == nil {
		t.Fatal("stable cut without the stable flatpak passed")
	}
	if got := versionInURL("https://x/api/packages/LibreLoom/generic/luna/0.3.0/luna-os-x86_64.img.xz", "luna", "luna-os-x86_64.img.xz"); got != "0.3.0" {
		t.Fatalf("versionInURL %q", got)
	}
}

func TestDevFeedsSignedWithDevKey(t *testing.T) {
	w := newWorld(t)
	ctx := context.Background()
	_, err := w.app.Build(ctx, BuildRequest{Unit: "fake"})
	must(t, err)
	_, err = w.app.Build(ctx, BuildRequest{Unit: "fake", Version: "0.3.1-0.dev.20"})
	must(t, err)
	key, err := w.app.DevKey()
	must(t, err)
	h := w.app.DevHandler(w.app.OutRoot(), "http://dev.test:1", key)
	srv := httptest.NewServer(h)
	defer srv.Close()
	get := func(p string) []byte {
		resp, err := http.Get(srv.URL + p)
		must(t, err)
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("%s: HTTP %d", p, resp.StatusCode)
		}
		b, _ := io.ReadAll(resp.Body)
		return b
	}
	for _, ch := range []string{"stable", "beta"} {
		b, sig := get("/feeds/fake/"+ch+".json"), get("/feeds/fake/"+ch+".json.minisig")
		f, err := publish.ParseFeed(key.Public, b, sig)
		must(t, err)
		// newest build wins (0.3.1-0.dev.20 > 0.3.1-0.dev.7)
		if f.Version != "0.3.1-0.dev.20" || f.Channel != ch || len(f.Parts) != 2 {
			t.Fatalf("%s feed %+v", ch, f)
		}
		if !strings.HasPrefix(f.Parts[0].URLs[0], "http://dev.test:1/files/fake/0.3.1-0.dev.20/") {
			t.Fatalf("url %v", f.Parts[0].URLs)
		}
		// production's key must not verify it
		if minisign.Verify(w.pub, b, sig) {
			t.Fatal("dev feed verifies with another key")
		}
		// every advertised file downloads (relative to the test server)
		for _, p := range f.Parts {
			u := strings.TrimPrefix(p.URLs[0], "http://dev.test:1")
			if len(get(u)) == 0 {
				t.Fatalf("empty %s", u)
			}
		}
	}
	// Verify-style check through the real client against the test server
	if _, err := publish.VerifyFeed(ctx, nil, srv.URL+"/feeds/fake/stable.json", key.Public); err == nil {
		t.Log("note: URLs point at dev.test, so VerifyFeed cannot fetch them here")
	}
}

func TestRepoAndroidPin(t *testing.T) {
	dir := t.TempDir()
	if _, ok := repoAndroidPin(dir); ok {
		t.Fatal("pin from an empty repo")
	}
	must(t, os.MkdirAll(filepath.Join(dir, "keys"), 0o755))
	fp := strings.Repeat("ab", 32)
	must(t, os.WriteFile(filepath.Join(dir, AndroidCertPinFile), []byte("# release cert\n"+strings.ToUpper(fp[:2])+":"+fp[2:]+"\n"), 0o644))
	if got, ok := repoAndroidPin(dir); !ok || got != fp {
		t.Fatalf("pin = %q %v", got, ok)
	}
	must(t, os.WriteFile(filepath.Join(dir, AndroidCertPinFile), []byte("abcd\n"), 0o644))
	if _, ok := repoAndroidPin(dir); ok {
		t.Fatal("short pin accepted")
	}
}
