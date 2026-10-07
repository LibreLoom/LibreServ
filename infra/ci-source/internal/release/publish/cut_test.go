package publish

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"aead.dev/minisign"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/feed"
)

func TestCutHappyPath(t *testing.T) {
	w := newWorld(t)
	res, err := Run(context.Background(), w.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if res.Tag != "luna/v0.4.0" || res.SHA == "" || res.FeedSHA == "" {
		t.Fatalf("result %+v", res)
	}
	// bump commit on origin main, exactly the release SHA
	if got := sh(t, w.origin, "rev-parse", "main"); got != res.SHA {
		t.Fatalf("origin main %s, release %s", got, res.SHA)
	}
	if got := sh(t, w.origin, "log", "-1", "--format=%s", "main"); got != "chore(release): luna 0.4.0" {
		t.Fatalf("subject %q", got)
	}
	// tag only on forgejo, at the release SHA, pushed after the mirror had both commits
	if w.tags(w.origin) != "" {
		t.Fatalf("tag leaked to origin: %s", w.tags(w.origin))
	}
	if got := sh(t, w.forgejo, "rev-parse", "luna/v0.4.0^{commit}"); got != res.SHA {
		t.Fatalf("tag at %s", got)
	}
	// registry: part + sums + sig, hashes agree
	base := "/api/packages/LibreLoom/generic/luna/0.4.0/"
	for _, f := range []string{"lunad-linux-amd64-musl", SumsName, SumsSigName} {
		if _, ok := w.reg.files[base+f]; !ok {
			t.Fatalf("registry lacks %s", f)
		}
	}
	// sums and feeds verify with the signer's public key
	pub := w.cfg.Signer.(MinisignSigner).Key.Public().(minisign.PublicKey)
	if !minisign.Verify(pub, w.reg.files[base+SumsName], w.reg.files[base+SumsSigName]) {
		t.Fatal("sums signature does not verify")
	}
	// feeds branch: stable + beta (no beta existed), one commit
	for _, ch := range []string{"stable", "beta"} {
		b := sh(t, w.origin, "show", "feeds:luna/"+ch+".json")
		var f feed.Feed
		if err := json.Unmarshal([]byte(b), &f); err != nil {
			t.Fatal(err)
		}
		if f.Version != "0.4.0" || f.Channel != ch || f.Published != "2026-10-12T14:03:00Z" || len(f.Parts) != 1 {
			t.Fatalf("%s feed %+v", ch, f)
		}
		if !strings.HasSuffix(f.Parts[0].URLs[0], "/generic/luna/0.4.0/lunad-linux-amd64-musl") {
			t.Fatalf("url %v", f.Parts[0].URLs)
		}
		sig := sh(t, w.origin, "show", "feeds:luna/"+ch+".json.minisig")
		if !strings.Contains(sig, "trusted comment: libreserv feed luna "+ch+" 0.4.0") {
			t.Fatalf("sig %s", sig)
		}
	}
	if n := sh(t, w.origin, "rev-list", "--count", "feeds"); n != "1" {
		t.Fatalf("feeds commits %s", n)
	}
	// every step recorded
	st := loadSingleState(t, w)
	for _, s := range Steps {
		if !st.Done[s] {
			t.Fatalf("step %s not done", s)
		}
	}
	// token never in the state file
	b, err := os.ReadFile(filepath.Join(w.cfg.StateDir, strings.TrimSuffix(stateName("luna", "0.4.0", res.SHA), ".json")+doneSuffix))
	if err != nil {
		t.Fatalf("finished cut is not marked: %v", err)
	}
	if strings.Contains(string(b), testToken) {
		t.Fatal("token in state")
	}
	// a second fresh cut is refused (the tag exists) but not with "resume it":
	// the cut is finished. Resume of a finished cut is a no-op.
	if _, err := Run(context.Background(), w.cfg); err == nil || errors.Is(err, ErrCutExists) || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("want a tag-exists refusal, got %v", err)
	}
	w.cfg.Resume = true
	builds := w.builds
	if _, err := Run(context.Background(), w.cfg); err != nil || w.builds != builds {
		t.Fatalf("resume of done cut: %v builds %d->%d", err, builds, w.builds)
	}
}

func loadSingleState(t *testing.T, w *world) State {
	t.Helper()
	m, _ := filepath.Glob(filepath.Join(w.cfg.StateDir, "*.json"))
	if len(m) != 1 {
		t.Fatalf("state files %v", m)
	}
	b, _ := os.ReadFile(m[0])
	var st State
	if err := json.Unmarshal(b, &st); err != nil {
		t.Fatal(err)
	}
	return st
}

// Failing before a step and failing after its effect but before it was
// recorded must both resume to the same single result.
func TestCutResumeAtEveryStep(t *testing.T) {
	for _, step := range Steps {
		for _, mode := range []string{"before", "after-effect"} {
			t.Run(step+"/"+mode, func(t *testing.T) {
				w := newWorld(t)
				boom := errors.New("injected failure")
				fail := func(s string) error {
					if s == step {
						return boom
					}
					return nil
				}
				cfg := w.cfg
				if mode == "before" {
					cfg.beforeStep = fail
				} else {
					cfg.afterEffect = fail
				}
				if _, err := Run(context.Background(), cfg); !errors.Is(err, boom) {
					t.Fatalf("want injected failure, got %v", err)
				}
				// a fresh cut now refuses (once the bump has a SHA)...
				if step != StepBump || mode != "before" {
					if _, err := Run(context.Background(), w.cfg); !errors.Is(err, ErrCutExists) {
						t.Fatalf("fresh cut: %v", err)
					}
				}
				// ...and resume finishes.
				cfg = w.cfg
				cfg.Resume = true
				res, err := Run(context.Background(), cfg)
				if err != nil {
					t.Fatal(err)
				}
				if got := sh(t, w.forgejo, "rev-parse", "luna/v0.4.0^{commit}"); got != res.SHA {
					t.Fatalf("tag at %s want %s", got, res.SHA)
				}
				if n := sh(t, w.origin, "rev-list", "--count", "--grep=^chore(release): luna 0.4.0$", "main"); n != "1" {
					t.Fatalf("bump commits on main: %s", n)
				}
				if n := sh(t, w.origin, "rev-list", "--count", "feeds"); n != "1" {
					t.Fatalf("feed commits %s", n)
				}
				if len(w.reg.files) != 3 {
					t.Fatalf("registry files %d", len(w.reg.files))
				}
			})
		}
	}
}

func TestCutResumeWithoutSavedStateAfterBumpCrash(t *testing.T) {
	// the bump was pushed but the state never got written
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
	cfg = w.cfg
	cfg.Resume = true
	// preflight would object (tree is clean, tag free: it passes), the bump is reused
	if _, err := Run(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if n := sh(t, w.origin, "rev-list", "--count", "--grep=^chore(release): luna 0.4.0$", "main"); n != "1" {
		t.Fatalf("bump commits %s", n)
	}
}

func TestCutRebuildsWhenOutputGone(t *testing.T) {
	w := newWorld(t)
	boom := errors.New("injected")
	cfg := w.cfg
	cfg.beforeStep = func(s string) error {
		if s == StepUpload {
			return boom
		}
		return nil
	}
	if _, err := Run(context.Background(), cfg); !errors.Is(err, boom) {
		t.Fatal(err)
	}
	os.RemoveAll(filepath.Join(w.root, "dist"))
	cfg = w.cfg
	cfg.Resume = true
	b := w.builds
	if _, err := Run(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if w.builds != b+1 {
		t.Fatalf("builds %d -> %d", b, w.builds)
	}
}

func TestCutRebasesWhenOriginMoved(t *testing.T) {
	w := newWorld(t)
	w.moveOrigin("bot1.txt") // checkout is now behind origin
	res, err := Run(context.Background(), w.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if got := sh(t, w.origin, "rev-parse", "main"); got != res.SHA {
		t.Fatal("release SHA is not origin main")
	}
	if got := sh(t, w.origin, "show", "main~1:bot1.txt"); got != "x" {
		t.Fatal("bot commit lost")
	}
	// the built tree is the rebased one
	if got := sh(t, w.origin, "show", res.SHA+":luna/VERSION"); got != "0.4.0" {
		t.Fatal(got)
	}
}

func TestBumpRebaseRetryWhenRejectedAfterFetch(t *testing.T) {
	// origin moves between the fetch and the push: a pre-push hook in the
	// checkout lands a bot commit once, so the first push is rejected.
	w := newWorld(t)
	hook := filepath.Join(w.repo, ".git", "hooks", "pre-push")
	flag := filepath.Join(w.root, "hook-ran")
	script := "#!/bin/sh\nif [ ! -e " + flag + " ]; then touch " + flag + "\n" +
		"c=" + filepath.Join(w.root, "hookclone") + "\n" +
		"git clone -q " + w.origin + " $c && cd $c && echo x > hook.txt && git add . && git commit -q -m bot && git push -q origin HEAD:main\nfi\nexit 0\n"
	os.WriteFile(hook, []byte(script), 0o755)
	res, err := Run(context.Background(), w.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(flag); err != nil {
		t.Fatal("hook never ran")
	}
	if got := sh(t, w.origin, "show", "main~1:hook.txt"); got != "x" {
		t.Fatal("expected rebased on top of the bot commit")
	}
	if sh(t, w.origin, "rev-parse", "main") != res.SHA {
		t.Fatal("sha mismatch")
	}
}

func TestBumpRebaseConflictFails(t *testing.T) {
	w := newWorld(t)
	c := filepath.Join(w.root, "conf")
	sh(t, w.root, "clone", "-q", w.origin, c)
	os.WriteFile(filepath.Join(c, "luna", "VERSION"), []byte("9.9.9\n"), 0o644)
	sh(t, c, "commit", "-qam", "conflicting")
	sh(t, c, "push", "-q", "origin", "HEAD:main")
	if _, err := Run(context.Background(), w.cfg); err == nil || !strings.Contains(err.Error(), "rebase") {
		t.Fatalf("want rebase error, got %v", err)
	}
	// repo left usable: no rebase in progress
	if _, err := os.Stat(filepath.Join(w.repo, ".git", "rebase-merge")); err == nil {
		t.Fatal("rebase left running")
	}
}

func TestCutRefusesDirtyTreeAndExistingTag(t *testing.T) {
	w := newWorld(t)
	os.WriteFile(filepath.Join(w.repo, "luna", "VERSION"), []byte("dirty\n"), 0o644)
	if _, err := Run(context.Background(), w.cfg); err == nil || !strings.Contains(err.Error(), "not clean") {
		t.Fatalf("dirty: %v", err)
	}
	sh(t, w.repo, "checkout", "--", "luna/VERSION")
	sh(t, w.repo, "tag", "luna/v0.4.0")
	sh(t, w.repo, "push", "-q", "forgejo", "luna/v0.4.0")
	sh(t, w.repo, "tag", "-d", "luna/v0.4.0")
	if _, err := Run(context.Background(), w.cfg); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("tag: %v", err)
	}
}

func TestCutConflictingReupload(t *testing.T) {
	w := newWorld(t)
	// someone already put different bytes under the same name
	w.reg.files["/api/packages/LibreLoom/generic/luna/0.4.0/lunad-linux-amd64-musl"] = []byte("other bytes")
	_, err := Run(context.Background(), w.cfg)
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("want ErrConflict, got %v", err)
	}
	if strings.Contains(err.Error(), testToken) {
		t.Fatal("token in error")
	}
	// nothing past the upload happened
	if w.tags(w.forgejo) != "" {
		t.Fatal("tag pushed")
	}
	if sh(t, w.origin, "branch", "--list", "feeds") != "" {
		t.Fatal("feeds pushed")
	}
}

func TestCutNeverPushesTagBeforeMirror(t *testing.T) {
	w := newWorld(t)
	w.mirrorAt = 4 // the first few polls say "not yet"
	w.cfg.afterEffect = func(s string) error {
		if s == StepMirror && w.tags(w.forgejo) != "" {
			return errors.New("tag existed before mirror finished")
		}
		return nil
	}
	if _, err := Run(context.Background(), w.cfg); err != nil {
		t.Fatal(err)
	}
	if w.polls < 4 {
		t.Fatalf("polls %d", w.polls)
	}
}

func TestCutMirrorTimeout(t *testing.T) {
	w := newWorld(t)
	w.mirrorAt = 1 << 30
	w.cfg.PollTimeout = 30 * 1e6
	_, err := Run(context.Background(), w.cfg)
	if err == nil || !strings.Contains(err.Error(), "mirror") {
		t.Fatalf("want mirror timeout, got %v", err)
	}
	if w.tags(w.forgejo) != "" {
		t.Fatal("tag pushed without mirror")
	}
}

func TestDryRunTouchesNothing(t *testing.T) {
	w := newWorld(t)
	w.cfg.Dry = true
	headBefore := sh(t, w.repo, "rev-parse", "HEAD")
	originBefore := sh(t, w.origin, "rev-parse", "main")
	res, err := Run(context.Background(), w.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if !res.Dry || res.SHA == "" {
		t.Fatalf("%+v", res)
	}
	if sh(t, w.repo, "rev-parse", "HEAD") != headBefore || sh(t, w.origin, "rev-parse", "main") != originBefore {
		t.Fatal("dry run moved a branch")
	}
	if sh(t, w.repo, "status", "--porcelain") != "" {
		t.Fatal("dry run dirtied the checkout")
	}
	if len(w.reg.files) != 0 || w.reg.puts != 0 {
		t.Fatal("dry run uploaded")
	}
	if sh(t, w.origin, "branch", "--list", "feeds") != "" || w.tags(w.forgejo) != "" || w.tags(w.repo) != "" {
		t.Fatal("dry run pushed or tagged")
	}
	if _, err := os.Stat(filepath.Join(res.OutDir, "dry-feeds", "luna", "stable.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(w.cfg.StateDir); err == nil {
		t.Fatal("dry run wrote state")
	}
}

func TestCutResumeKeepsSavedNotes(t *testing.T) {
	w := newWorld(t)
	boom := errors.New("injected failure")
	cfg := w.cfg
	cfg.Release.Notes = "Saved notes from the first run"
	cfg.beforeStep = func(s string) error {
		if s == StepFeed {
			return boom
		}
		return nil
	}
	if _, err := Run(context.Background(), cfg); !errors.Is(err, boom) {
		t.Fatalf("want injected failure, got %v", err)
	}
	// The resume doesn't know the notes; the saved ones must be published.
	cfg = w.cfg
	cfg.Release.Notes = ""
	cfg.Resume = true
	if _, err := Run(context.Background(), cfg); err != nil {
		t.Fatal(err)
	}
	if got := sh(t, w.origin, "show", "feeds:luna/stable.json"); !strings.Contains(got, "Saved notes from the first run") {
		t.Fatalf("feed lost the saved notes:\n%s", got)
	}
}

// pointAtForge gives a remote the URL https://gt.test/LibreLoom/LibreServ.git
// while git still talks to the local bare repo through insteadOf.
func (w *world) pointAtForge(remote, bare string) {
	const u = "https://gt.test/LibreLoom/LibreServ.git"
	sh(w.t, w.repo, "config", "remote."+remote+".url", u)
	sh(w.t, w.repo, "config", "url."+bare+".insteadOf", u)
	w.cfg.ForgeHost = "gt.test"
}

func TestCutOriginIsTheForge(t *testing.T) {
	w := newWorld(t)
	sh(t, w.repo, "remote", "remove", "forgejo")
	w.pointAtForge("origin", w.origin)
	w.forgejo = w.origin // the fake API reads the forge's repo
	w.mirrorAt = 1 << 30 // there is no mirror: polling must not be needed
	res, err := Run(context.Background(), w.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if got := sh(t, w.origin, "rev-parse", "luna/v0.4.0^{commit}"); got != res.SHA {
		t.Fatalf("tag at %s, want %s", got, res.SHA)
	}
	if w.polls != 2 { // one lookup per commit, nothing more
		t.Fatalf("%d API lookups", w.polls)
	}
}

func TestCutFindsForgeRemoteByURL(t *testing.T) {
	w := newWorld(t)
	sh(t, w.repo, "remote", "rename", "forgejo", "gt")
	w.pointAtForge("gt", w.forgejo)
	res, err := Run(context.Background(), w.cfg)
	if err != nil {
		t.Fatal(err)
	}
	if w.tags(w.origin) != "" || sh(t, w.forgejo, "rev-parse", "luna/v0.4.0^{commit}") != res.SHA {
		t.Fatal("tag must land on the remote that points at the forge only")
	}
}

func TestCutNoRemotePointsAtForge(t *testing.T) {
	w := newWorld(t)
	sh(t, w.repo, "remote", "remove", "forgejo")
	w.cfg.ForgeHost = "gt.test"
	_, err := Run(context.Background(), w.cfg)
	if err == nil || !strings.Contains(err.Error(), "No git remote points at gt.test; add one with `git remote add forgejo https://gt.test/LibreLoom/LibreServ.git`") {
		t.Fatalf("err = %v", err)
	}
	if sh(t, w.origin, "log", "--format=%s", "main") != "init" {
		t.Fatal("something was pushed")
	}
}

func TestCutExplicitForgeRemote(t *testing.T) {
	w := newWorld(t)
	sh(t, w.repo, "remote", "rename", "forgejo", "elsewhere")
	w.cfg.ForgeHost = "gt.test"
	w.cfg.Forgejo = "elsewhere"
	if _, err := Run(context.Background(), w.cfg); err != nil {
		t.Fatal(err)
	}
}

func TestURLHost(t *testing.T) {
	for in, want := range map[string]string{
		"https://gt.plainskill.net/LibreLoom/LibreServ.git":        "gt.plainskill.net",
		"https://user:tok@GT.plainskill.net:443/a/b.git":           "gt.plainskill.net",
		"ssh://git@gt.plainskill.net:2222/LibreLoom/LibreServ.git": "gt.plainskill.net",
		"git@gt.plainskill.net:LibreLoom/LibreServ.git":            "gt.plainskill.net",
		"git@github.com:LibreLoom/LibreServ.git":                   "github.com",
		"/var/tmp/origin.git":                                      "",
		"../origin.git":                                            "",
	} {
		if got := urlHost(in); got != want {
			t.Errorf("urlHost(%q) = %q, want %q", in, got, want)
		}
	}
}
