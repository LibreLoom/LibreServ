package parts

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

func testContext(unit string) *engine.BuildContext {
	return &engine.BuildContext{
		Unit: unit, Version: "1.2.3-beta.4", Commit: strings.Repeat("ab12", 10),
		SrcDir: "/tmp/src", OutRoot: "/tmp/out",
	}
}

func graphFor(t *testing.T, unit string) (*engine.BuildContext, *engine.Graph) {
	t.Helper()
	b := testContext(unit)
	g, err := engine.BuildGraph(b, For(unit))
	if err != nil {
		t.Fatal(err)
	}
	return b, g
}

func jobDeps(g *engine.Graph) map[string][]string {
	m := map[string][]string{}
	for _, j := range g.Jobs() {
		d := append([]string(nil), j.Deps...)
		sort.Strings(d)
		m[j.ID] = d
	}
	return m
}

func TestSolGraphShape(t *testing.T) {
	_, g := graphFor(t, "sol")
	want := map[string][]string{
		"sol/web":              nil,
		"sol/sol:restic-amd64": nil,
		"sol/sol:amd64":        {"sol/sol:restic-amd64", "sol/web"},
		"sol/sol:restic-arm64": nil,
		"sol/sol:arm64":        {"sol/sol:restic-arm64", "sol/web"},
	}
	if got := jobDeps(g); !reflect.DeepEqual(got, want) {
		t.Fatalf("jobs = %v\nwant %v", got, want)
	}
}

func TestSolArtifacts(t *testing.T) {
	b := testContext("sol")
	var files []string
	for _, a := range Artifacts(b, For("sol")) {
		files = append(files, a.File+"|"+a.Part+"|"+a.OS+"|"+a.Arch)
		if a.Path != filepath.Join("/tmp/out/sol/1.2.3-beta.4/sol", a.File) {
			t.Errorf("path %s", a.Path)
		}
	}
	want := []string{"libreserv-linux-amd64|sol|linux|amd64", "libreserv-linux-arm64|sol|linux|arm64"}
	if !reflect.DeepEqual(files, want) {
		t.Fatalf("got %v want %v", files, want)
	}
}

func TestConnectGraphShapeAndFiles(t *testing.T) {
	_, g := graphFor(t, "sol-connect")
	want := map[string][]string{
		"sol-connect/server":       nil,
		"sol-connect/web:admin":    nil,
		"sol-connect/web:customer": nil,
		"sol-connect/web":          {"sol-connect/web:admin", "sol-connect/web:customer"},
	}
	if got := jobDeps(g); !reflect.DeepEqual(got, want) {
		t.Fatalf("jobs = %v\nwant %v", got, want)
	}
	_, g = graphFor(t, "luna-connect")
	want = map[string][]string{
		"luna-connect/server":   nil,
		"luna-connect/web:site": nil,
		"luna-connect/web":      {"luna-connect/web:site"},
	}
	if got := jobDeps(g); !reflect.DeepEqual(got, want) {
		t.Fatalf("jobs = %v\nwant %v", got, want)
	}
	for _, unit := range []string{"sol-connect", "luna-connect"} {
		var files []string
		for _, a := range Artifacts(testContext(unit), For(unit)) {
			files = append(files, a.Part+"="+a.File)
		}
		sort.Strings(files)
		want := []string{"server=" + unit + "-server-linux-amd64", "web=" + unit + "-web.tar.gz"}
		if !reflect.DeepEqual(files, want) {
			t.Errorf("%s: %v want %v", unit, files, want)
		}
	}
}

func TestStampRejectsUnsafeValues(t *testing.T) {
	b := testContext("sol")
	b.Version = "1.0.0 -X evil=1"
	if _, err := newStamp(b); err == nil {
		t.Fatal("want error for a version with spaces")
	}
	b.Version = ""
	if _, err := newStamp(b); err == nil {
		t.Fatal("want error for an empty version")
	}
}

func TestStampLdflags(t *testing.T) {
	s := stamp{Version: "1.2.3", Commit: "c0ffee", Time: "2026-01-02T03:04:05Z"}
	got := s.ldflags(solPkgSystem+".Version", solPkgSystem+".GitCommit", solPkgSystem+".BuildTime")
	for _, w := range []string{
		"-s -w", "-X " + solPkgSystem + ".Version=1.2.3", "-X " + solPkgSystem + ".GitCommit=c0ffee",
		"-X " + solPkgSystem + ".BuildTime=2026-01-02T03:04:05Z",
	} {
		if !strings.Contains(got, w) {
			t.Errorf("ldflags %q lacks %q", got, w)
		}
	}
}

func TestFetchRestic(t *testing.T) {
	bz, _ := hex.DecodeString("425a683931415926535978d98029000004d180001000022b281c002000220069908069a68bbcd1c112578bb9229c28483c6cc01480")
	hits := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits++
		if !strings.HasSuffix(r.URL.Path, "/v"+resticVersion+"/restic_"+resticVersion+"_linux_amd64.bz2") {
			http.NotFound(w, r)
			return
		}
		w.Write(bz)
	}))
	defer srv.Close()
	oldBase, oldSums := resticBase, resticSums["amd64"]
	defer func() { resticBase, resticSums["amd64"] = oldBase, oldSums }()
	resticBase = srv.URL
	resticSums["amd64"] = "5a0628bd49778dd0face932a6bc05f64ce5021142e09b5179f08104181c58d32"

	dir := filepath.Join(t.TempDir(), "amd64")
	logf := func(string, ...any) {}
	if err := fetchRestic(context.Background(), dir, "amd64", logf); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(dir, "restic"))
	if err != nil || string(b) != "restic-fake\n" {
		t.Fatalf("restic = %q, %v", b, err)
	}
	if fi, _ := os.Stat(filepath.Join(dir, "restic")); fi.Mode()&0o111 == 0 {
		t.Error("restic is not executable")
	}
	if ents, _ := os.ReadDir(dir); len(ents) != 1 {
		t.Errorf("leftover files in cache dir: %v", ents)
	}
	if err := fetchRestic(context.Background(), dir, "amd64", logf); err != nil || hits != 1 {
		t.Fatalf("second fetch should be a no-op: err=%v hits=%d", err, hits)
	}

	// A wrong checksum is refused and leaves nothing behind.
	resticSums["amd64"] = strings.Repeat("0", 64)
	dir2 := filepath.Join(t.TempDir(), "amd64")
	if err := fetchRestic(context.Background(), dir2, "amd64", logf); err == nil || !strings.Contains(err.Error(), "sha256") {
		t.Fatalf("want checksum error, got %v", err)
	}
	if ents, _ := os.ReadDir(dir2); len(ents) != 0 {
		t.Errorf("left files after a bad download: %v", ents)
	}
}

func readTar(t *testing.T, path string) map[string]string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	got := map[string]string{}
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return got
		}
		if err != nil {
			t.Fatal(err)
		}
		b, _ := io.ReadAll(tr)
		got[h.Name] = string(b)
	}
}

func TestPackTarGzLayout(t *testing.T) {
	root := t.TempDir()
	write := func(p, s string) {
		os.MkdirAll(filepath.Dir(filepath.Join(root, p)), 0o755)
		os.WriteFile(filepath.Join(root, p), []byte(s), 0o600)
	}
	write("admin/index.html", "A")
	write("admin/assets/x.js", "X")
	write("customer/index.html", "C")
	members := []tarMember{{filepath.Join(root, "admin"), "admin"}, {filepath.Join(root, "customer"), "customer"}}
	dest := filepath.Join(t.TempDir(), "w.tar.gz")
	if err := packTarGz(dest, members, []string{"admin/index.html", "customer/index.html"}); err != nil {
		t.Fatal(err)
	}
	got := readTar(t, dest)
	for name, body := range map[string]string{"admin/index.html": "A", "admin/assets/x.js": "X", "customer/index.html": "C"} {
		if got[name] != body {
			t.Errorf("%s = %q", name, got[name])
		}
	}
	for name := range got {
		if strings.HasPrefix(name, "/") || strings.HasPrefix(name, "./") || strings.Contains(name, "..") {
			t.Errorf("unsafe entry %q", name)
		}
	}
	// Reproducible.
	dest2 := filepath.Join(t.TempDir(), "w2.tar.gz")
	if err := packTarGz(dest2, members, nil); err != nil {
		t.Fatal(err)
	}
	a, _ := os.ReadFile(dest)
	b, _ := os.ReadFile(dest2)
	if string(a) != string(b) {
		t.Error("tarball is not reproducible")
	}
	// Root-level site (luna-connect) and missing requirement.
	if err := packTarGz(dest, []tarMember{{filepath.Join(root, "admin"), ""}}, []string{"index.html"}); err != nil {
		t.Fatal(err)
	}
	if g := readTar(t, dest); g["index.html"] != "A" || g["assets/x.js"] != "X" {
		t.Errorf("root layout: %v", g)
	}
	if err := packTarGz(dest, members, []string{"nope/index.html"}); err == nil {
		t.Fatal("want error for a missing required path")
	}
}
