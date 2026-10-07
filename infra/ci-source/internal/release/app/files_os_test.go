package app

import (
	"crypto/rand"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"aead.dev/minisign"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
)

func TestLunaAttachedInputsFiles(t *testing.T) {
	dir := t.TempDir()
	for f, body := range map[string]string{"lunad-linux-amd64-musl": "x"} {
		must(t, os.WriteFile(filepath.Join(dir, f), []byte(body), 0o644))
	}
	// not built, only reused: the sidecars may be missing and never become feed parts
	specs := DefaultFileSpecs("luna")
	got, err := resolveSpecs("luna", "stable", dir, specs, func(string) (publish.PartSpec, bool) {
		return publish.PartSpec{Version: "0.3.0", Size: 5, SHA256: "ab"}, true
	})
	must(t, err)
	for _, p := range got {
		if filepath.Ext(p.File) == ".inputs" || p.Name == "" {
			t.Fatalf("sidecar became a feed part: %+v", p)
		}
	}
	// flatten brings a built os image's .inputs up to the version dir
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "os"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "os", "luna-os-x86_64.img.xz"), []byte("i"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "os", "luna-os-x86_64.img.xz.inputs"), []byte("h\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "os", "luna-os-x86_64.img.xz.sha256"), []byte("s\n"), 0o644))
	missing, err := flatten(root, specs)
	must(t, err)
	if _, err := os.Stat(filepath.Join(root, "luna-os-x86_64.img.xz.inputs")); err != nil {
		t.Fatalf("inputs not uploaded with the release: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "luna-os-x86_64.img.xz.sha256")); err == nil {
		t.Fatal("the .sha256 scratch file was published")
	}
	// the missing list holds the real files only, never the optional sidecars
	for _, m := range missing {
		if filepath.Ext(m) == ".inputs" {
			t.Fatalf("optional sidecar reported missing: %v", missing)
		}
	}
}

// released picks the newest version across both feeds and keeps the URL.
func TestReleasedPicksNewestAcrossFeeds(t *testing.T) {
	pub, priv, err := minisign.GenerateKey(rand.Reader)
	must(t, err)
	repo := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(repo, "keys"), 0o755))
	pt, _ := pub.MarshalText()
	must(t, os.WriteFile(filepath.Join(repo, "keys", PublicKeyFile("luna")), append([]byte("untrusted comment: test\n"), pt...), 0o644))

	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	defer srv.Close()
	feedFor := func(channel, ver string) {
		rel := publish.Release{Unit: "luna", Version: ver, Channel: channel, Published: "2026-10-01T00:00:00Z",
			Parts: []publish.PartSpec{{Name: "os", OS: "linux", Arch: "amd64", File: "luna-os-x86_64.img.xz", Version: ver, Size: 7, SHA256: "ab" + ver}}}
		files := map[string]publish.FileInfo{"luna-os-x86_64.img.xz": {Size: 7, SHA256: "ab" + ver}}
		f, err := publish.BuildFeed(rel, channel, files, func(v, file string) string { return srv.URL + "/api/packages/LibreLoom/generic/luna/" + v + "/" + file })
		must(t, err)
		out, err := publish.SignFeeds([]publish.FeedOut{{Channel: channel, Feed: f}}, publish.MinisignSigner{Key: priv})
		must(t, err)
		for _, o := range out {
			data := o.Data
			mux.HandleFunc("/LibreLoom/LibreServ/raw/branch/feeds/"+o.Path, func(w http.ResponseWriter, r *http.Request) { w.Write(data) })
		}
	}
	feedFor("stable", "0.3.0")
	feedFor("beta", "0.4.0-beta.2")

	a, err := New(Config{Repo: repo, CacheDir: t.TempDir(), ForgejoURL: srv.URL, Signer: publish.MinisignSigner{Key: priv}})
	must(t, err)
	lookup := a.newLookup("luna").released(t.Context())
	r, ok := lookup("os")
	if !ok || r.Version != "0.4.0-beta.2" || r.SHA256 != "ab0.4.0-beta.2" || r.Size != 7 ||
		r.URL != srv.URL+"/api/packages/LibreLoom/generic/luna/0.4.0-beta.2/luna-os-x86_64.img.xz" {
		t.Fatalf("released %+v %v", r, ok)
	}
	if _, ok := lookup("installer"); ok {
		t.Fatal("found a part no feed lists")
	}
}
