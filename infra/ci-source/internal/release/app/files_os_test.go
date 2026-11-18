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

func TestLunaReleaseShipsImageAndInstaller(t *testing.T) {
	dir := t.TempDir()
	specs := DefaultFileSpecs("luna")
	// A luna package holds the whole system: the image (daemon, packs and all)
	// and the factory ISO. There is no daemon part, and nothing is reused from
	// an earlier release — that reuse is what produced 0.0.4's package with a
	// single binary in it.
	var files []string
	for _, s := range specs {
		files = append(files, s.File)
	}
	if len(files) != 2 || files[0] != "luna-os-x86_64.img.xz" || files[1] != "luna-rapidinstall-x86_64.iso.xz" {
		t.Fatalf("luna parts %v", files)
	}
	for _, f := range files {
		must(t, os.WriteFile(filepath.Join(dir, f), []byte("x"), 0o644))
	}
	got, err := resolveSpecs("luna", "stable", dir, specs)
	must(t, err)
	for _, p := range got {
		if p.Name == "lunad" || filepath.Ext(p.File) == ".inputs" {
			t.Fatalf("unexpected feed part: %+v", p)
		}
	}

	// flatten brings the built files up to the version dir and never publishes
	// the .sha256 scratch file image.sh leaves beside the image.
	root := t.TempDir()
	must(t, os.MkdirAll(filepath.Join(root, "os"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, "os", "luna-os-x86_64.img.xz"), []byte("i"), 0o644))
	must(t, os.WriteFile(filepath.Join(root, "os", "luna-os-x86_64.img.xz.sha256"), []byte("s\n"), 0o644))
	if _, err := flatten(root, specs); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "luna-os-x86_64.img.xz")); err != nil {
		t.Fatalf("the image did not reach the release dir: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "luna-os-x86_64.img.xz.sha256")); err == nil {
		t.Fatal("the .sha256 scratch file was published")
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
