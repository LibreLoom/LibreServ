package app

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

// Builds luna's OS image and installer ISO for real (rootless podman, several
// minutes) through the app layer, then builds the whole unit again from the
// same inputs to prove the second run does not rebuild them. Slow:
// LIBRESERV_RELEASE_SLOW_TESTS=1; skipped without podman or with
// LIBRESERV_RELEASE_NO_PODMAN_TESTS set.
func TestBuildLunaOSAndInstaller(t *testing.T) {
	if os.Getenv("LIBRESERV_RELEASE_SLOW_TESTS") == "" {
		t.Skip("slow: set LIBRESERV_RELEASE_SLOW_TESTS=1")
	}
	if _, err := exec.LookPath("podman"); err != nil || os.Getenv("LIBRESERV_RELEASE_NO_PODMAN_TESTS") != "" {
		t.Skip("podman not available")
	}
	if err := exec.Command("podman", "info").Run(); err != nil {
		t.Skip("podman not usable: ", err)
	}
	out, err := exec.Command("git", "rev-parse", "--show-toplevel").Output()
	if err != nil {
		t.Skip("not in a git checkout: ", err)
	}
	repo := strings.TrimSpace(string(out))

	cache, dist := t.TempDir(), t.TempDir()
	var mu sync.Mutex
	logs := map[string][]string{}
	run := func(name string, parts []string) (*BuildResult, time.Duration) {
		mu.Lock()
		logs = map[string][]string{}
		mu.Unlock()
		eng, err := engine.New(engine.Config{Repo: repo, CacheDir: cache})
		must(t, err)
		a, err := New(Config{Repo: repo, Engine: eng, CacheDir: cache, OutRoot: filepath.Join(dist, name),
			OnEvent: func(ev Event) {
				if ev.Kind == EventBuild && ev.Build.Type == engine.EventLog {
					mu.Lock()
					logs[ev.Build.Job] = append(logs[ev.Build.Job], ev.Build.Line)
					mu.Unlock()
				}
			}})
		must(t, err)
		start := time.Now()
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Minute)
		defer cancel()
		res, err := a.Build(ctx, BuildRequest{Unit: "luna", Version: "9.9.9-0.dev.1", Parts: parts})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		d := time.Since(start)
		for _, j := range res.Jobs {
			t.Logf("%s: %-22s %-9s %s", name, j.ID, j.Status, j.Duration.Round(time.Second))
		}
		t.Logf("%s: total %s", name, d.Round(time.Second))
		return res, d
	}

	// 1. named parts: always built.
	res1, d1 := run("first", []string{"os", "installer"})
	dir1 := res1.Units[0].Dir
	img1 := filepath.Join(dir1, "luna-os-x86_64.img.xz")
	iso1 := filepath.Join(dir1, "luna-rapidinstall-x86_64.iso.xz")
	for _, f := range []string{img1, iso1, img1 + ".inputs", iso1 + ".inputs"} {
		if st, err := os.Stat(f); err != nil || st.Size() == 0 {
			t.Fatalf("missing %s: %v", f, err)
		}
	}
	if _, err := os.Stat(filepath.Join(dir1, "luna-os-x86_64.img.xz.sha256")); err == nil {
		t.Error("the .sha256 scratch file leaked into the release dir")
	}
	if xz, err := exec.LookPath("xz"); err == nil {
		for _, f := range []string{img1, iso1} {
			if out, err := exec.Command(xz, "-t", f).CombinedOutput(); err != nil {
				t.Errorf("xz -t %s: %v %s", f, err, out)
			}
		}
	}
	// The ISO embeds exactly the released image: its sha256 is in the ISO's /luna.
	sha, _ := os.ReadFile(img1 + ".inputs")
	t.Logf("os inputs %s", strings.TrimSpace(string(sha)))
	if len(logs["luna/installer:iso"]) == 0 {
		t.Error("no installer log")
	}

	// 2. the whole unit again, same inputs: nothing OS-related is rebuilt.
	res2, d2 := run("second", nil)
	dir2 := res2.Units[0].Dir
	for _, f := range []string{"luna-os-x86_64.img.xz", "luna-rapidinstall-x86_64.iso.xz"} {
		a, err1 := os.ReadFile(filepath.Join(dir1, f+".inputs"))
		b, err2 := os.ReadFile(filepath.Join(dir2, f+".inputs"))
		if err1 != nil || err2 != nil || string(a) != string(b) {
			t.Errorf("%s inputs differ: %q %q (%v %v)", f, a, b, err1, err2)
		}
		s1, e1 := os.Stat(filepath.Join(dir1, f))
		s2, e2 := os.Stat(filepath.Join(dir2, f))
		if e1 != nil || e2 != nil || !os.SameFile(s1, s2) {
			t.Errorf("%s was rebuilt (not the cached file)", f)
		}
	}
	for _, id := range []string{"luna/os:rootfs", "luna/os:image", "luna/installer:live", "luna/installer:iso"} {
		if l := strings.Join(logs[id], "\n"); !strings.Contains(l, "skipped") && l != "" {
			t.Errorf("%s ran on the second build:\n%s", id, l)
		}
	}
	if !strings.Contains(strings.Join(logs["luna/os:hash"], "\n"), "OS image: cached") {
		t.Errorf("second build did not take the cached image:\n%s", strings.Join(logs["luna/os:hash"], "\n"))
	}
	t.Logf("first %s, second %s", d1.Round(time.Second), d2.Round(time.Second))
}
