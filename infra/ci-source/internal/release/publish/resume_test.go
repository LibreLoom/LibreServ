package publish

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func localBump(t *testing.T, w *world) string {
	t.Helper()
	must := func(err error) {
		if err != nil {
			t.Fatal(err)
		}
	}
	must(os.WriteFile(filepath.Join(w.repo, "luna", "VERSION"), []byte("0.4.0\n"), 0o644))
	sh(t, w.repo, "commit", "-q", "-am", "chore(release): luna 0.4.0")
	return sh(t, w.repo, "rev-parse", "HEAD")
}

func resumeCfg(w *world) Config {
	cfg := w.cfg
	cfg.Resume = true
	return cfg
}

func TestResumePushesTheFoundBumpCommit(t *testing.T) {
	w := newWorld(t)
	bump := localBump(t, w) // committed, never pushed, no state saved
	res, err := Run(context.Background(), resumeCfg(w))
	if err != nil {
		t.Fatal(err)
	}
	if res.SHA != bump || sh(t, w.origin, "rev-parse", "main") != bump {
		t.Fatalf("release %s, origin %s, bump commit %s", res.SHA, sh(t, w.origin, "rev-parse", "main"), bump)
	}
}

func TestResumeRefusesWhenHeadMovedPastTheBump(t *testing.T) {
	w := newWorld(t)
	bump := localBump(t, w)
	os.WriteFile(filepath.Join(w.repo, "other.txt"), []byte("x"), 0o644)
	sh(t, w.repo, "add", "other.txt")
	sh(t, w.repo, "commit", "-q", "-m", "unrelated work")
	before := sh(t, w.origin, "rev-parse", "main")
	_, err := Run(context.Background(), resumeCfg(w))
	if err == nil || !strings.Contains(err.Error(), "has moved on") || !strings.Contains(err.Error(), bump[:12]) {
		t.Fatalf("want a clear refusal, got %v", err)
	}
	if sh(t, w.origin, "rev-parse", "main") != before {
		t.Fatal("something was pushed")
	}
}

func TestStatelessResumeKeepsDirtyAndTagChecks(t *testing.T) {
	w := newWorld(t)
	os.WriteFile(filepath.Join(w.repo, "luna", "VERSION"), []byte("dirty\n"), 0o644)
	if _, err := Run(context.Background(), resumeCfg(w)); err == nil || !strings.Contains(err.Error(), "not clean") {
		t.Fatalf("dirty tree: %v", err)
	}
	sh(t, w.repo, "checkout", "--", "luna/VERSION")
	// a tag of that name that points somewhere else is refused
	sh(t, w.repo, "tag", "luna/v0.4.0")
	sh(t, w.repo, "push", "-q", "forgejo", "luna/v0.4.0")
	sh(t, w.repo, "tag", "-d", "luna/v0.4.0")
	_, err := Run(context.Background(), resumeCfg(w))
	if err == nil || !strings.Contains(err.Error(), "not at the release commit") {
		t.Fatalf("stale tag: %v", err)
	}
}

func TestStatelessResumeAcceptsItsOwnTag(t *testing.T) {
	w := newWorld(t)
	boom := errors.New("injected")
	cfg := w.cfg
	cfg.afterEffect = func(s string) error {
		if s == StepTag {
			return boom
		}
		return nil
	}
	if _, err := Run(context.Background(), cfg); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	os.RemoveAll(w.cfg.StateDir) // crashed right after the tag push
	res, err := Run(context.Background(), resumeCfg(w))
	if err != nil {
		t.Fatal(err)
	}
	if sh(t, w.forgejo, "rev-parse", "luna/v0.4.0^{commit}") != res.SHA {
		t.Fatal("tag moved")
	}
}

func TestFindBumpAfterCrashBeforeStateSave(t *testing.T) {
	w := newWorld(t)
	boom := errors.New("injected")
	cfg := w.cfg
	cfg.afterEffect = func(s string) error {
		if s == StepBump {
			return boom
		}
		return nil
	}
	if _, err := Run(context.Background(), cfg); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	os.RemoveAll(w.cfg.StateDir)
	g := Git{Dir: w.repo}
	v, sha, err := g.FindBump(context.Background(), "origin", "main", "luna")
	if err != nil || v != "0.4.0" || sha != sh(t, w.origin, "rev-parse", "main") {
		t.Fatalf("FindBump = %q %q %v", v, sha, err)
	}
	if v, _, err := g.FindBump(context.Background(), "origin", "main", "other"); err != nil || v != "" {
		t.Fatalf("other unit: %q %v", v, err)
	}
}

func TestFinishedCutIsNotUnfinishedAndTagCanBeRestored(t *testing.T) {
	w := newWorld(t)
	res, err := Run(context.Background(), w.cfg)
	if err != nil {
		t.Fatal(err)
	}
	m, _ := filepath.Glob(filepath.Join(w.cfg.StateDir, "*.json"))
	if len(m) != 1 || !StateFinished(m[0]) {
		t.Fatalf("state files %v", m)
	}
	// somebody deletes the tag; the finished cut is picked up again at the tag step
	sh(t, w.forgejo, "tag", "-d", "luna/v0.4.0")
	sh(t, w.repo, "tag", "-d", "luna/v0.4.0")
	builds := w.builds
	res2, err := Run(context.Background(), resumeCfg(w))
	if err != nil {
		t.Fatal(err)
	}
	if res2.SHA != res.SHA || sh(t, w.forgejo, "rev-parse", "luna/v0.4.0^{commit}") != res.SHA || w.builds != builds {
		t.Fatalf("tag not restored cleanly: %+v builds %d->%d", res2, builds, w.builds)
	}
	m, _ = filepath.Glob(filepath.Join(w.cfg.StateDir, "*.json"))
	if len(m) != 1 || !StateFinished(m[0]) {
		t.Fatalf("state files after the redo %v", m)
	}
}

func TestResumeAfterFeedPushedReportsEveryChannel(t *testing.T) {
	w := newWorld(t)
	boom := errors.New("injected")
	cfg := w.cfg
	cfg.afterEffect = func(s string) error {
		if s == StepFeed {
			return boom
		}
		return nil
	}
	if _, err := Run(context.Background(), cfg); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	res, err := Run(context.Background(), resumeCfg(w))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(res.Channels, ",") != "stable,beta" {
		t.Fatalf("channels %v", res.Channels)
	}
}

func TestDryRunResolvesRemotesLikeARealCut(t *testing.T) {
	w := newWorld(t)
	w.cfg.Dry = true
	w.cfg.ForgeHost = "forge.example.invalid"
	sh(t, w.repo, "remote", "remove", "forgejo")
	if _, err := Run(context.Background(), w.cfg); err == nil || !strings.Contains(err.Error(), "No git remote points at") {
		t.Fatalf("dry run did not check the remotes: %v", err)
	}
	w.cfg.Resume = true
	if _, err := Run(context.Background(), w.cfg); err == nil || !strings.Contains(err.Error(), "dry run cannot be resumed") {
		t.Fatalf("dry+resume: %v", err)
	}
}
