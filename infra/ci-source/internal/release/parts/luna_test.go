package parts

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

// lunaCtx is a BuildContext over a fake export, enough to describe jobs.
func lunaCtx(t *testing.T, unit, ver string) *engine.BuildContext {
	t.Helper()
	src := t.TempDir()
	write := func(rel, body string) {
		p := filepath.Join(src, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("luna/VERSION", "0.4.0\n")
	write("luna/desktop/VERSION", "0.4.0\n")
	write("luna/desktop/packaging/windows/msys2-manifest.txt", "abc  x.pkg.tar.zst\n")
	write("luna/mobile/app/build.gradle.kts", "android {\n    defaultConfig {\n        versionCode = 40099\n        versionName = \"0.4.0\"\n    }\n}\n")
	e, err := engine.New(engine.Config{CacheDir: t.TempDir(), ImagesDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	return &engine.BuildContext{Engine: e, Unit: unit, Version: ver, Commit: strings.Repeat("a", 40),
		SrcDir: src, OutRoot: t.TempDir()}
}

func jobIDs(t *testing.T, b *engine.BuildContext, ps ...engine.Part) map[string][]string {
	t.Helper()
	g, err := engine.BuildGraph(b, ps)
	if err != nil {
		t.Fatal(err)
	}
	m := map[string][]string{}
	for _, j := range g.Jobs() {
		m[j.ID] = j.Deps
	}
	return m
}

func hasArg(args []string, want string) bool {
	for _, a := range args {
		if a == want {
			return true
		}
	}
	return false
}

func TestLunadGraph(t *testing.T) {
	b := lunaCtx(t, "luna", "0.4.1-0.dev.12")
	m := jobIDs(t, b, &Lunad{})
	want := map[string][]string{
		"luna/lunad:web":   nil,
		"luna/lunad:build": {"luna/lunad:web"},
		"luna/lunad:smoke": {"luna/lunad:build"},
		"luna/lunad":       {"luna/lunad:smoke"},
	}
	if len(m) != len(want) {
		t.Fatalf("jobs %v", m)
	}
	for id, deps := range want {
		if strings.Join(m[id], ",") != strings.Join(deps, ",") {
			t.Errorf("%s deps %v, want %v", id, m[id], deps)
		}
	}
	if LunadFile != "lunad-linux-amd64-musl" {
		t.Fatal(LunadFile)
	}
}

func TestLunadSpecs(t *testing.T) {
	b := lunaCtx(t, "luna", "0.4.1-0.dev.12")
	e := b.Engine
	img := engine.Image{Name: "x", Hash: "h"}

	build, err := lunadBuildSpec(b)
	if err != nil {
		t.Fatal(err)
	}
	args := e.RunArgs(img, build, "n")
	joined := strings.Join(args, " ")
	for _, w := range []string{
		b.SrcDir + ":/src:ro",
		"-e PATCH_VERSION ",
		"/src/luna/crates/lunad/web/dist:ro",
		engine.VolumePrefix + "target-luna-musl:/src/luna/target",
		"--memory 6g",
	} {
		if !strings.Contains(joined, w) {
			t.Errorf("build args lack %q:\n%s", w, joined)
		}
	}
	// The version is patched into the binary, not mounted over VERSION.
	if strings.Contains(joined, "/src/luna/VERSION") {
		t.Errorf("build args mount luna/VERSION:\n%s", joined)
	}
	// Mount points exist in the export; nothing else was written there.
	for _, d := range []string{"luna/target", "luna/crates/lunad/web/dist"} {
		if st, err := os.Stat(filepath.Join(b.SrcDir, d)); err != nil || !st.IsDir() {
			t.Errorf("no mount point %s", d)
		}
	}

	smoke := lunadSmokeSpec(b)
	sargs := e.RunArgs(img, smoke, "n")
	if !hasArg(sargs, "none") || !strings.Contains(strings.Join(sargs, " "), "EXPECT_VERSION") {
		t.Errorf("smoke args %v", sargs)
	}
	if smoke.Image != "alpine-smoke" {
		t.Errorf("smoke image %s", smoke.Image)
	}
}

func TestScriptsParse(t *testing.T) {
	for _, tc := range []struct{ shell, file string }{
		{"bash", "luna-web.sh"}, {"bash", "lunad-build.sh"}, {"sh", "lunad-smoke.sh"},
		{"bash", "flatpak.sh"}, {"bash", "windows.sh"}, {"bash", "android.sh"},
	} {
		sh, err := exec.LookPath(tc.shell)
		if err != nil {
			t.Skip(tc.shell, "not installed")
		}
		cmd := exec.Command(sh, "-n")
		cmd.Stdin = strings.NewReader(lunaScript(tc.file))
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Errorf("%s: %v\n%s", tc.file, err, out)
		}
	}
}

// ---- integration (real podman) ----

func podmanOrSkip(t *testing.T) {
	t.Helper()
	if os.Getenv("LIBRESERV_RELEASE_NO_PODMAN_TESTS") != "" {
		t.Skip("LIBRESERV_RELEASE_NO_PODMAN_TESTS set")
	}
	if testing.Short() {
		t.Skip("short mode")
	}
	if _, err := exec.LookPath("podman"); err != nil {
		t.Skip("podman not available")
	}
	if err := exec.Command("podman", "info").Run(); err != nil {
		t.Skip("podman not usable: ", err)
	}
}

// slowOrSkip gates builds that take many minutes (flatpak, windows, apk).
func slowOrSkip(t *testing.T) {
	t.Helper()
	podmanOrSkip(t)
	if os.Getenv("LIBRESERV_RELEASE_SLOW_TESTS") == "" {
		t.Skip("set LIBRESERV_RELEASE_SLOW_TESTS=1 to run this multi-minute build")
	}
}

// lunaRealCtx exports HEAD of this repository and returns a context that
// builds it for real into a temp dir, using the shared host caches.
func lunaRealCtx(t *testing.T, unit, ver string) *engine.BuildContext {
	t.Helper()
	top, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		t.Skip("not in a git checkout")
	}
	repo := strings.TrimSpace(string(top))
	e, err := engine.New(engine.Config{Repo: repo})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	dir, sha, err := e.Export(ctx, "HEAD")
	if err != nil {
		t.Fatal(err)
	}
	return &engine.BuildContext{Engine: e, Unit: unit, Version: ver, Commit: sha, SrcDir: dir, OutRoot: t.TempDir()}
}

// runGraph builds the parts' graph one heavy job at a time and logs timings.
func runGraph(t *testing.T, b *engine.BuildContext, ps ...engine.Part) time.Duration {
	t.Helper()
	g, err := engine.BuildGraph(b, ps)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Minute)
	defer cancel()
	res, err := g.Run(ctx, engine.Options{Jobs: 2, HeavyJobs: 1, Engine: b.Engine, Redactor: b.Engine.Redactor,
		OnEvent: func(ev engine.Event) {
			switch ev.Type {
			case engine.EventLog:
				t.Logf("[%s] %s", ev.Job, ev.Line)
			case engine.EventFinished:
				t.Logf("%s: %s in %s", ev.Job, ev.Status, ev.Elapsed.Round(time.Second))
			}
		}})
	if err != nil {
		t.Fatal(err)
	}
	if !res.OK() {
		t.Fatal(res.FirstError())
	}
	return res.Duration
}

// srcSnapshot lists every path of the export, to prove a build left it alone.
func srcSnapshot(t *testing.T, dir string) []string {
	t.Helper()
	var out []string
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		if d.IsDir() && (strings.HasSuffix(rel, "node_modules") || strings.HasSuffix(rel, "/target") || strings.HasSuffix(rel, "/dist") || strings.HasSuffix(rel, "/build") || strings.HasSuffix(rel, ".gradle")) {
			return filepath.SkipDir
		}
		if !d.IsDir() {
			out = append(out, rel)
		}
		return nil
	})
	return out
}

func TestIntegrationLunad(t *testing.T) {
	podmanOrSkip(t)
	b := lunaRealCtx(t, "luna", "0.4.1-0.dev.12")
	before := srcSnapshot(t, b.SrcDir)
	cold := runGraph(t, b, &Lunad{})
	t.Logf("first run: %s", cold.Round(time.Second))

	bin := filepath.Join(b.PartOutDir("lunad"), LunadFile)
	st, err := os.Stat(bin)
	if err != nil || st.Size() < 1<<20 {
		t.Fatalf("lunad binary: %v %v", st, err)
	}
	if _, err := os.Stat(LunaConsolePath(b)); err != nil {
		t.Fatal(err)
	}
	if after := srcSnapshot(t, b.SrcDir); strings.Join(before, "\n") != strings.Join(after, "\n") {
		t.Errorf("build changed the exported source tree")
	}

	warm := runGraph(t, b, &Lunad{})
	t.Logf("second run (warm caches): %s", warm.Round(time.Second))
}

// The mounted VERSION file must get a newer mtime whenever the version
// changes (cargo's persistent target/ volumes go by mtime), also when going
// back to an older version, and keep it when nothing changed.
func TestVersionMountMtime(t *testing.T) {
	src, out := t.TempDir(), t.TempDir()
	os.MkdirAll(filepath.Join(src, "luna"), 0o755)
	os.WriteFile(filepath.Join(src, "luna", "VERSION"), []byte("0.4.0\n"), 0o644)
	mk := func(v string) string {
		b := &engine.BuildContext{Unit: "luna", Version: v, SrcDir: src, OutRoot: out}
		m, err := lunaVersionMount(b, "luna/VERSION")
		if err != nil {
			t.Fatal(err)
		}
		return m.Host
	}
	mtime := func(p string) time.Time { st, _ := os.Stat(p); return st.ModTime() }
	p := mk("1.0.0")
	t1 := mtime(p)
	// Pretend time has passed so equal mtimes cannot hide a missing rewrite.
	old := t1.Add(-time.Hour)
	os.Chtimes(p, old, old)
	if mk("1.0.0"); !mtime(p).Equal(old) {
		t.Error("an unchanged version touched the file")
	}
	for _, v := range []string{"1.0.1", "1.0.0"} {
		os.Chtimes(p, old, old)
		mk(v)
		if !mtime(p).After(old) {
			t.Errorf("version %s did not move the mtime forward", v)
		}
		if got, _ := os.ReadFile(p); string(got) != v+"\n" {
			t.Errorf("file holds %q, want %s", got, v)
		}
	}
}
