package feed

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"aead.dev/minisign"
)

const testdata = "../../../../../infra/feed-testdata"

type fixtureReq struct {
	Unit                string `json:"unit"`
	Channel             string `json:"channel"`
	OS                  string `json:"os"`
	Arch                string `json:"arch"`
	Part                string `json:"part"`
	InstalledVersion    string `json:"installed_version"`
	NewestPublishedSeen string `json:"newest_published_seen"`
}

type fixtures struct {
	URLBase string `json:"url_base"`
	Cases   []struct {
		Name    string     `json:"name"`
		Feed    string     `json:"feed"`
		Sig     string     `json:"sig"`
		Expect  string     `json:"expect"`
		Request fixtureReq `json:"request"`
	} `json:"cases"`
	Semver struct {
		Ascending []string `json:"ascending"`
		Invalid   []string `json:"invalid"`
	} `json:"semver"`
	Sums struct {
		File  string `json:"file"`
		Sig   string `json:"sig"`
		Cases []struct {
			Name   string `json:"name"`
			File   string `json:"file"`
			Expect string `json:"expect"`
		} `json:"cases"`
	} `json:"sums"`
}

func readFile(t *testing.T, rel string) []byte {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(testdata, rel))
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func loadFixtures(t *testing.T) (fixtures, []minisign.PublicKey) {
	t.Helper()
	var fx fixtures
	if err := json.Unmarshal(readFile(t, "cases.json"), &fx); err != nil {
		t.Fatal(err)
	}
	var pk minisign.PublicKey
	for _, line := range strings.Split(string(readFile(t, "test-key.pub")), "\n") {
		if strings.HasPrefix(line, "RW") {
			if err := pk.UnmarshalText([]byte(strings.TrimSpace(line))); err != nil {
				t.Fatal(err)
			}
		}
	}
	return fx, []minisign.PublicKey{pk}
}

func fixtureServer(t *testing.T) *httptest.Server {
	root := filepath.Join(testdata, "files")
	fs := http.FileServer(http.Dir(root))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/missing/") {
			http.NotFound(w, r)
			return
		}
		fs.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestFixtureCases(t *testing.T) {
	fx, keys := loadFixtures(t)
	srv := fixtureServer(t)
	for _, c := range fx.Cases {
		t.Run(c.Name, func(t *testing.T) {
			body := readFile(t, c.Feed)
			sig := readFile(t, c.Sig)
			req := Request(c.Request)
			res, err := Check(keys, body, sig, req)
			kind, reason, _ := strings.Cut(c.Expect, ":")
			switch kind {
			case "update", "no-update":
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				if res.Update != (kind == "update") {
					t.Fatalf("Update = %v, want %v", res.Update, kind == "update")
				}
			case "reject":
				if err == nil {
					t.Fatal("expected rejection")
				}
				if got := Reason(err); got != reason {
					t.Fatalf("reason = %q (%v), want %q", got, err, reason)
				}
			case "download-ok", "download-fail":
				if err != nil {
					t.Fatalf("check failed: %v", err)
				}
				part := *res.Part
				for i, u := range part.URLs {
					part.URLs[i] = strings.Replace(u, fx.URLBase, srv.URL, 1)
				}
				dest := filepath.Join(t.TempDir(), "out")
				derr := Download(context.Background(), srv.Client(), &part, dest)
				if kind == "download-ok" {
					if derr != nil {
						t.Fatalf("download: %v", derr)
					}
					if _, err := os.Stat(dest); err != nil {
						t.Fatal(err)
					}
					return
				}
				if derr == nil || Reason(derr) != reason {
					t.Fatalf("download error reason = %q (%v), want %q", Reason(derr), derr, reason)
				}
				if _, err := os.Stat(dest); err == nil {
					t.Fatal("failed download left a file behind")
				}
			default:
				t.Fatalf("unknown expectation %q", c.Expect)
			}
		})
	}
}

func TestSemverFixtures(t *testing.T) {
	fx, _ := loadFixtures(t)
	for i, s := range fx.Semver.Ascending {
		v, err := ParseVersion(s)
		if err != nil {
			t.Fatalf("%q should parse: %v", s, err)
		}
		if i > 0 {
			prev, _ := ParseVersion(fx.Semver.Ascending[i-1])
			if !prev.LessThan(v) {
				t.Fatalf("%q should sort before %q", prev, v)
			}
		}
	}
	for _, s := range fx.Semver.Invalid {
		if _, err := ParseVersion(s); err == nil {
			t.Fatalf("%q should be rejected", s)
		}
	}
}

func TestSumsFixtures(t *testing.T) {
	fx, keys := loadFixtures(t)
	sums := readFile(t, fx.Sums.File)
	if err := Verify(keys, sums, readFile(t, fx.Sums.Sig)); err != nil {
		t.Fatalf("sums signature: %v", err)
	}
	for _, c := range fx.Sums.Cases {
		t.Run(c.Name, func(t *testing.T) {
			got, ok := SumsLookup(sums, c.File)
			if c.Expect == "not-found" {
				if ok {
					t.Fatalf("found %q, want not-found", got)
				}
				return
			}
			if !ok || got != c.Expect {
				t.Fatalf("got %q ok=%v, want %q", got, ok, c.Expect)
			}
		})
	}
	if h, ok := SumsLookup([]byte("abc *file.bin\n"), "file.bin"); !ok || h != "abc" {
		t.Fatal("leading * marker should be accepted")
	}
}

func TestDownloadStopsReadingPastSize(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Repeat("x", 1<<20)))
	}))
	defer srv.Close()
	dest := filepath.Join(t.TempDir(), "out")
	err := Download(context.Background(), srv.Client(), &Part{Size: 10, SHA256: "00", URLs: []string{srv.URL}}, dest)
	if Reason(err) != "size-mismatch" {
		t.Fatalf("got %v", err)
	}
}

func TestCheckNoKeysRejects(t *testing.T) {
	if _, err := Check(nil, []byte("{}"), nil, Request{}); Reason(err) != "bad-signature" {
		t.Fatalf("got %v", err)
	}
}
