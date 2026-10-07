package app

import (
	"crypto/rand"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"aead.dev/minisign"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
)

func TestDefaultClientsSplitAPIAndTransfer(t *testing.T) {
	a, err := New(Config{Repo: t.TempDir(), CacheDir: t.TempDir(), NoKeyring: true})
	must(t, err)
	if a.cfg.HTTP.Timeout == 0 || a.cfg.HTTP.Timeout > 2*60*1e9 {
		t.Fatalf("API client timeout %s should be short", a.cfg.HTTP.Timeout)
	}
	if a.cfg.Transfer == nil || a.cfg.Transfer.Timeout != 0 {
		t.Fatalf("transfer client must have no overall timeout: %+v", a.cfg.Transfer)
	}
	reg, forge := a.registry(&secrets.ForgejoCreds{Token: "x"})
	if reg.HTTP != a.cfg.Transfer || forge.HTTP != a.cfg.HTTP {
		t.Fatal("registry must use the transfer client and Forgejo the API client")
	}
}

func lookupApp(t *testing.T, h http.Handler, withKey bool) (*App, *httptest.Server) {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	repo := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(repo, "keys"), 0o755))
	if withKey {
		pub, _, err := minisign.GenerateKey(rand.Reader)
		must(t, err)
		pt, _ := pub.MarshalText()
		must(t, os.WriteFile(filepath.Join(repo, "keys", PublicKeyFile("luna")), append([]byte("untrusted comment: t\n"), pt...), 0o644))
	}
	a, err := New(Config{Repo: repo, CacheDir: t.TempDir(), ForgejoURL: srv.URL, NoKeyring: true})
	must(t, err)
	return a, srv
}

func TestFeedLookupOnly404MeansNothingReleased(t *testing.T) {
	var hits atomic.Int32
	a, _ := lookupApp(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		http.NotFound(w, r)
	}), true)
	lk := a.newLookup("luna")
	feeds, err := lk.load(t.Context())
	if err != nil || len(feeds) != 0 {
		t.Fatalf("404 must mean no earlier release: %v %v", feeds, err)
	}
	if _, ok := lk.released(t.Context())("os"); ok {
		t.Fatal("found a release in an empty feed")
	}
	lk.load(t.Context())
	if hits.Load() != 2 { // stable + beta, once
		t.Fatalf("feeds fetched %d times, want 2 (one shared lookup)", hits.Load())
	}
}

func TestFeedLookupFailuresAreErrors(t *testing.T) {
	for name, h := range map[string]http.HandlerFunc{
		"server error": func(w http.ResponseWriter, r *http.Request) { http.Error(w, "boom", 502) },
		"bad signature": func(w http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(r.URL.Path, ".minisig") {
				w.Write([]byte("untrusted comment: x\nRWQ\n"))
				return
			}
			w.Write([]byte(`{"format":1}`))
		},
		"unsigned": func(w http.ResponseWriter, r *http.Request) {
			if strings.HasSuffix(r.URL.Path, ".minisig") {
				http.NotFound(w, r)
				return
			}
			w.Write([]byte(`{"format":1}`))
		},
	} {
		t.Run(name, func(t *testing.T) {
			a, _ := lookupApp(t, h, true)
			lk := a.newLookup("luna")
			if _, err := lk.load(t.Context()); err == nil || !strings.Contains(err.Error(), "cannot check what luna already released") {
				t.Fatalf("want a clear error, got %v", err)
			}
			if _, ok := lk.released(t.Context())("os"); ok {
				t.Fatal("reported a release despite the error")
			}
		})
	}
	t.Run("missing key", func(t *testing.T) {
		a, _ := lookupApp(t, http.NotFoundHandler(), false)
		if _, err := a.newLookup("luna").load(t.Context()); err == nil {
			t.Fatal("missing public key accepted")
		}
	})
	t.Run("unreachable", func(t *testing.T) {
		a, srv := lookupApp(t, http.NotFoundHandler(), true)
		srv.Close()
		if _, err := a.newLookup("luna").load(t.Context()); err == nil {
			t.Fatal("unreachable forge accepted")
		}
	})
}

func failingFeeds(status int) http.RoundTripper {
	return roundTrip(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: status, Body: http.NoBody, Header: http.Header{}, Request: r}, nil
	})
}

type roundTrip func(*http.Request) (*http.Response, error)

func (f roundTrip) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestCutStopsWhenFeedsCannotBeRead(t *testing.T) {
	w := newWorld(t)
	w.app.cfg.HTTP = &http.Client{Transport: failingFeeds(503)}
	before := git(t, w.origin, "rev-parse", "main")
	_, err := w.app.Cut(t.Context(), CutRequest{Unit: "fake", Channel: "stable"})
	var pe *PreflightError
	if !errors.As(err, &pe) || !strings.Contains(err.Error(), "cannot check what fake already released") {
		t.Fatalf("want a preflight error about the feeds, got %v", err)
	}
	if git(t, w.origin, "rev-parse", "main") != before {
		t.Fatal("a bump was pushed although the feeds could not be read")
	}
	// the build step shares the same lookup and refuses before building anything
	build := w.app.cutBuild(CutRequest{Unit: "fake", Channel: "stable"}, "0.3.1", w.app.newLookup("fake"))
	if _, err := build(t.Context(), publish.Source{Repo: w.repo, SHA: "deadbeef"}); err == nil || !strings.Contains(err.Error(), "cannot check what fake already released") {
		t.Fatalf("build: %v", err)
	}
}

func TestDryCutKeepsRealOutputAndRefusesResume(t *testing.T) {
	w := newWorld(t)
	real := filepath.Join(w.app.cfg.CacheDir, "cut-dist", "fake", "0.3.1")
	must(t, os.MkdirAll(real, 0o755))
	marker := filepath.Join(real, "precious.bin")
	must(t, os.WriteFile(marker, []byte("x"), 0o644))
	res, err := w.app.Cut(t.Context(), CutRequest{Unit: "fake", Channel: "stable", Dry: true})
	must(t, err)
	if _, err := os.Stat(marker); err != nil {
		t.Fatalf("a dry run wiped a real cut's output: %v", err)
	}
	if !strings.Contains(res.OutDir, filepath.Join("cut-dist", "dry")) {
		t.Fatalf("dry output at %s", res.OutDir)
	}
	_, err = w.app.Cut(t.Context(), CutRequest{Unit: "fake", Channel: "stable", Dry: true, Resume: true})
	if err == nil || !strings.Contains(err.Error(), "dry run cannot be resumed") {
		t.Fatalf("dry+resume: %v", err)
	}
	if rep := w.app.Preflight(t.Context(), CutRequest{Unit: "fake", Channel: "stable", Dry: true, Resume: true}); rep.OK() {
		t.Fatal("preflight accepts dry+resume")
	}
}

func TestPreflightChecksLiveFeeds(t *testing.T) {
	w := newWorld(t)
	ctx := t.Context()
	_, err := w.app.Cut(ctx, CutRequest{Unit: "fake", Channel: "stable"}) // feeds now at 0.3.1
	must(t, err)
	git(t, w.repo, "pull", "-q", "origin", "main")
	feedsCheck := func(req CutRequest) Check {
		for _, c := range w.app.Preflight(ctx, req).Checks {
			if c.Name == "feeds" {
				return c
			}
		}
		t.Fatal("no feeds check")
		return Check{}
	}
	// the same version again: published already
	if c := feedsCheck(CutRequest{Unit: "fake", Channel: "stable", Version: "0.3.1"}); c.State != CheckFail || !strings.Contains(c.Detail, "already at 0.3.1") {
		t.Fatalf("same version: %+v", c)
	}
	// a clock behind the last published
	w.app.cfg.Now = func() time.Time { return time.Date(2026, 10, 1, 0, 0, 0, 0, time.UTC) }
	if c := feedsCheck(CutRequest{Unit: "fake", Channel: "stable"}); c.State != CheckFail || !strings.Contains(c.Detail, "clock") {
		t.Fatalf("clock: %+v", c)
	}
	w.app.cfg.Now = func() time.Time { return time.Date(2026, 10, 13, 0, 0, 0, 0, time.UTC) }
	if c := feedsCheck(CutRequest{Unit: "fake", Channel: "stable"}); c.State != CheckOK {
		t.Fatalf("ok case: %+v", c)
	}
}

func TestEventsAreRedacted(t *testing.T) {
	var got []Event
	a, err := New(Config{Repo: t.TempDir(), CacheDir: t.TempDir(), NoKeyring: true, OnEvent: func(ev Event) { got = append(got, ev) }})
	must(t, err)
	a.Engine().Redactor.Add("s3cr3t-token-value")
	a.emit.emit(Event{Kind: EventCut, Step: "upload", Phase: PhaseFailed, Err: errors.New("PUT failed: token s3cr3t-token-value rejected")})
	a.emit.emit(Event{Kind: EventBuild, Build: engine.Event{Err: errors.New("boom s3cr3t-token-value")}})
	a.emit.note("luna", "using s3cr3t-token-value")
	if len(got) != 3 {
		t.Fatalf("%d events", len(got))
	}
	for _, text := range []string{got[0].Err.Error(), got[1].Build.Err.Error(), got[2].Message} {
		if strings.Contains(text, "s3cr3t") {
			t.Fatalf("secret leaked in %q", text)
		}
	}
	if !strings.Contains(got[0].Err.Error(), "PUT failed") {
		t.Fatalf("message lost: %v", got[0].Err)
	}
}
