package publish

import (
	"context"
	"crypto/rand"
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
)

func testKey(t *testing.T) (minisign.PublicKey, MinisignSigner) {
	t.Helper()
	pub, priv, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return pub, MinisignSigner{Key: priv}
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

func sh(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
	return strings.TrimSpace(string(out))
}

// fakeRegistry is an in-memory Forgejo generic registry.
type fakeRegistry struct {
	mu      sync.Mutex
	files   map[string][]byte
	puts    int
	failPut func(n int, path string) int // status to answer instead (0 = normal)
	token   string
}

func newFakeRegistry(token string) *fakeRegistry {
	return &fakeRegistry{files: map[string][]byte{}, token: token}
}

func (f *fakeRegistry) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.token != "" && r.Header.Get("Authorization") != "token "+f.token && r.Method != http.MethodGet {
		http.Error(w, "unauthorized", 401)
		return
	}
	p := r.URL.Path
	switch r.Method {
	case http.MethodPut:
		f.puts++
		if f.failPut != nil {
			if code := f.failPut(f.puts, p); code != 0 {
				http.Error(w, "injected", code)
				return
			}
		}
		if _, ok := f.files[p]; ok {
			http.Error(w, "exists", http.StatusConflict)
			return
		}
		b, _ := io.ReadAll(r.Body)
		f.files[p] = b
		w.WriteHeader(201)
	case http.MethodGet:
		b, ok := f.files[p]
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Write(b)
	case http.MethodDelete:
		if _, ok := f.files[p]; !ok {
			http.NotFound(w, r)
			return
		}
		delete(f.files, p)
		w.WriteHeader(204)
	}
}

// world is a full fake: origin and forgejo bare repos, a mirror that copies
// refs when the fake Forgejo API is polled, a registry and a working checkout.
type world struct {
	t        *testing.T
	root     string
	origin   string // bare
	forgejo  string // bare
	repo     string // user's checkout
	reg      *fakeRegistry
	srv      *httptest.Server
	mirrorAt int // mirror syncs on this poll (0 = at the first)
	polls    int
	cfg      Config
	builds   int
}

const testToken = "s3cret-token-value"

func newWorld(t *testing.T) *world {
	t.Helper()
	gitEnv(t)
	w := &world{t: t, root: t.TempDir(), reg: newFakeRegistry(testToken), mirrorAt: 2}
	w.origin = filepath.Join(w.root, "origin.git")
	w.forgejo = filepath.Join(w.root, "forgejo.git")
	sh(t, w.root, "init", "--bare", "-b", "main", w.origin)
	sh(t, w.root, "init", "--bare", "-b", "main", w.forgejo)
	w.repo = filepath.Join(w.root, "repo")
	sh(t, w.root, "clone", "--quiet", w.origin, w.repo)
	sh(t, w.repo, "checkout", "-q", "-B", "main")
	os.MkdirAll(filepath.Join(w.repo, "luna"), 0o755)
	os.WriteFile(filepath.Join(w.repo, "luna", "VERSION"), []byte("0.3.0\n"), 0o644)
	sh(t, w.repo, "add", ".")
	sh(t, w.repo, "commit", "-q", "-m", "init")
	sh(t, w.repo, "push", "-q", "origin", "main")
	sh(t, w.repo, "remote", "add", "forgejo", w.forgejo)

	mux := http.NewServeMux()
	mux.Handle("/api/packages/", w.reg)
	mux.HandleFunc("/api/v1/repos/LibreLoom/LibreServ/git/commits/", func(rw http.ResponseWriter, r *http.Request) {
		w.polls++
		if w.polls >= w.mirrorAt {
			w.mirror()
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

	pub, signer := testKey(t)
	_ = pub
	w.cfg = Config{
		Release: Release{Unit: "luna", Version: "0.4.0", Channel: Stable, Notes: "notes",
			Parts: []PartSpec{{Name: "lunad", OS: "linux", Arch: "amd64", File: "lunad-linux-amd64-musl"}}},
		Repo: w.repo, Owner: "LibreLoom", RepoName: "LibreServ",
		Bump: func(dir string) ([]string, error) {
			return []string{"luna/VERSION"}, os.WriteFile(filepath.Join(dir, "luna", "VERSION"), []byte("0.4.0\n"), 0o644)
		},
		Build: func(ctx context.Context, src Source) (string, error) {
			w.builds++
			// the release SHA must be readable where the builder is told to look
			if err := exec.Command("git", "-C", src.Repo, "cat-file", "-e", src.SHA+"^{commit}").Run(); err != nil {
				return "", fmt.Errorf("sha %s not in %s", src.SHA, src.Repo)
			}
			ver, err := exec.Command("git", "-C", src.Repo, "show", src.SHA+":luna/VERSION").Output()
			if err != nil {
				return "", err
			}
			dir := filepath.Join(w.root, "dist", src.SHA)
			os.MkdirAll(dir, 0o755)
			return dir, os.WriteFile(filepath.Join(dir, "lunad-linux-amd64-musl"), []byte("lunad built from "+strings.TrimSpace(string(ver))), 0o644)
		},
		Signer:    signer,
		Registry:  &Registry{BaseURL: w.srv.URL, Owner: "LibreLoom", Token: StaticToken(testToken)},
		Forge:     &Forgejo{BaseURL: w.srv.URL, Owner: "LibreLoom", Repo: "LibreServ", Token: StaticToken(testToken)},
		StateDir:  filepath.Join(w.root, "cuts"),
		PollEvery: time.Millisecond, PollTimeout: 5 * time.Second,
		Now: func() time.Time { return time.Date(2026, 10, 12, 14, 3, 0, 0, time.UTC) },
	}
	return w
}

// mirror copies origin's branches into forgejo (never tags: only the tool pushes those).
func (w *world) mirror() {
	cmd := exec.Command("git", "-C", w.forgejo, "fetch", "-q", w.origin, "+refs/heads/*:refs/heads/*")
	if out, err := cmd.CombinedOutput(); err != nil {
		w.t.Errorf("mirror: %v %s", err, out)
	}
}

func (w *world) tags(bare string) string { return sh(w.t, bare, "tag", "--list") }

// moveOrigin lands another commit on origin/main from a second clone.
func (w *world) moveOrigin(file string) {
	c := filepath.Join(w.root, "other-"+file)
	sh(w.t, w.root, "clone", "-q", w.origin, c)
	os.WriteFile(filepath.Join(c, file), []byte("x"), 0o644)
	sh(w.t, c, "add", ".")
	sh(w.t, c, "commit", "-q", "-m", "bot: "+file)
	sh(w.t, c, "push", "-q", "origin", "HEAD:main")
}
