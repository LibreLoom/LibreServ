package engine

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestHashDir(t *testing.T) {
	d := t.TempDir()
	os.WriteFile(filepath.Join(d, "Containerfile"), []byte("FROM scratch\n"), 0o644)
	h1, err := HashDir(d)
	if err != nil || len(h1) != 12 {
		t.Fatal(h1, err)
	}
	h2, _ := HashDir(d)
	if h1 != h2 {
		t.Fatal("hash not stable")
	}
	os.WriteFile(filepath.Join(d, "extra.sh"), []byte("x"), 0o644)
	h3, _ := HashDir(d)
	if h3 == h1 {
		t.Fatal("added file must change hash")
	}
	os.Chmod(filepath.Join(d, "extra.sh"), 0o755)
	h4, _ := HashDir(d)
	if h4 == h3 {
		t.Fatal("exec bit must change hash")
	}
	os.WriteFile(filepath.Join(d, "Containerfile"), []byte("FROM scratch\n# x\n"), 0o644)
	h5, _ := HashDir(d)
	if h5 == h4 {
		t.Fatal("content change must change hash")
	}
}

func TestLoadImage(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "flat")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "Containerfile"), []byte("FROM scratch\n"), 0o644)
	os.WriteFile(filepath.Join(dir, RunOptsFile), []byte("# bwrap\n--security-opt seccomp=unconfined\n--security-opt label=disable\n\n"), 0o644)
	img, err := LoadImage(root, "flat")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(img.Ref(), "libreserv-release/flat:") {
		t.Fatal(img.Ref())
	}
	want := []string{"--security-opt", "seccomp=unconfined", "--security-opt", "label=disable"}
	if strings.Join(img.RunOpts, " ") != strings.Join(want, " ") {
		t.Fatalf("%v", img.RunOpts)
	}
	if _, err := LoadImage(root, "../x"); err == nil {
		t.Fatal("bad name accepted")
	}
	imgs, err := ListImages(root)
	if err != nil || len(imgs) != 1 {
		t.Fatal(imgs, err)
	}
}

func TestRunArgs(t *testing.T) {
	e, _ := New(Config{CacheDir: t.TempDir()})
	img := Image{Name: "go", Hash: "abc", RunOpts: []string{"--security-opt", "unmask=ALL"}}
	args := e.RunArgs(img, RunSpec{
		Name: "x", Image: "go", Cmd: []string{"go", "build"},
		Source: "/s", Out: "/o", Memory: "2g",
		Caches: GoCaches(), Env: map[string]string{"TOKEN": "s3cr3t-value", "A": "1"},
	}, "cname")
	line := strings.Join(args, " ")
	for _, want := range []string{"--rm", "--memory 2g", "-v /s:/src", "-v /o:/out",
		"-v libreserv-release-gomod:/go/pkg/mod", "-e A -e TOKEN", "unmask=ALL",
		"libreserv-release/go:abc go build", "label=disable"} {
		if !strings.Contains(line, want) {
			t.Errorf("missing %q in %s", want, line)
		}
	}
	if strings.Contains(line, "s3cr3t-value") {
		t.Fatal("env value leaked into argv")
	}
	if strings.Contains(line, "--privileged") {
		t.Fatal("never privileged")
	}
}

func TestSplitLines(t *testing.T) {
	data := []byte("a\nb\r\nprogress 1%\rprogress 2%\rlast")
	var got []string
	for len(data) > 0 {
		adv, tok, _ := splitLines(data, true)
		got = append(got, string(tok))
		data = data[adv:]
	}
	want := "a|b|progress 1%|progress 2%|last"
	if strings.Join(got, "|") != want {
		t.Fatalf("%q", got)
	}
}

func gitRepo(t *testing.T) string {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	os.MkdirAll(filepath.Join(repo, "sub/dir"), 0o755)
	os.WriteFile(filepath.Join(repo, "a.txt"), []byte("one\n"), 0o444) // read-only in git? mode is 644 in git
	os.WriteFile(filepath.Join(repo, "sub/dir/run.sh"), []byte("#!/bin/sh\n"), 0o755)
	os.Symlink("a.txt", filepath.Join(repo, "link"))
	run("add", ".")
	run("commit", "-q", "-m", "one")
	return repo
}

func TestExportSource(t *testing.T) {
	repo := gitRepo(t)
	cache := t.TempDir()
	ctx := context.Background()

	dir, sha, err := ExportSource(ctx, repo, "HEAD", cache)
	if err != nil {
		t.Fatal(err)
	}
	if len(sha) != 40 || dir != filepath.Join(cache, "src", sha) {
		t.Fatal(dir, sha)
	}
	b, _ := os.ReadFile(filepath.Join(dir, "a.txt"))
	if string(b) != "one\n" {
		t.Fatal("content", string(b))
	}
	fi, _ := os.Stat(filepath.Join(dir, "sub/dir/run.sh"))
	if fi.Mode()&0o111 == 0 {
		t.Fatal("exec bit lost")
	}
	if l, err := os.Readlink(filepath.Join(dir, "link")); err != nil || l != "a.txt" {
		t.Fatal("symlink", l, err)
	}
	if _, err := os.Stat(filepath.Join(dir, ExportMarker)); err != nil {
		t.Fatal("marker missing")
	}
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		t.Fatal("export must not contain .git")
	}

	// Reuse: a file added to the export survives a second call.
	os.WriteFile(filepath.Join(dir, "scratch"), []byte("x"), 0o644)
	dir2, _, err := ExportSource(ctx, repo, sha, cache)
	if err != nil || dir2 != dir {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "scratch")); err != nil {
		t.Fatal("complete export was not reused")
	}

	// Incomplete export (no marker) is redone.
	os.Remove(filepath.Join(dir, ExportMarker))
	if _, _, err := ExportSource(ctx, repo, sha, cache); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "scratch")); err == nil {
		t.Fatal("partial export was not replaced")
	}
	if _, err := os.Stat(filepath.Join(dir, ExportMarker)); err != nil {
		t.Fatal("marker missing after redo")
	}

	// Bad ref.
	if _, _, err := ExportSource(ctx, repo, "nope", cache); err == nil {
		t.Fatal("bad ref accepted")
	}
	// No temp dirs left behind.
	ents, _ := os.ReadDir(filepath.Join(cache, "src"))
	for _, e := range ents {
		if strings.HasPrefix(e.Name(), ".tmp-") {
			t.Fatal("temp dir left", e.Name())
		}
	}
}

func TestExtractTarRejectsEscape(t *testing.T) {
	var buf bytes.Buffer
	if err := writeTar(&buf, "../evil", "x"); err != nil {
		t.Fatal(err)
	}
	if err := extractTar(&buf, t.TempDir()); err == nil {
		t.Fatal("escape accepted")
	}
}

func TestRedactor(t *testing.T) {
	var r Redactor
	r.Add("abc", "", "longsecret", "long")
	if got := r.Redact("x abc y longsecret z"); got != "x abc y *** z" {
		t.Fatal(got)
	}
	var nilR *Redactor
	if nilR.Redact("q") != "q" {
		t.Fatal("nil redactor")
	}
}

// A new export keeps the mtime of files whose bytes did not change since the
// earlier export (so cargo does not rebuild them) and stamps changed files
// later.
func TestExportInheritsMtimes(t *testing.T) {
	repo := gitRepo(t)
	cache := t.TempDir()
	ctx := context.Background()
	run := func(args ...string) {
		t.Helper()
		if out, err := exec.Command("git", append([]string{"-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"}, args...)...).CombinedOutput(); err != nil {
			t.Fatal(err, string(out))
		}
	}
	d1, _, err := ExportSource(ctx, repo, "HEAD", cache)
	if err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-48 * time.Hour)
	os.Chtimes(filepath.Join(d1, "a.txt"), past, past)
	os.WriteFile(filepath.Join(repo, "b.txt"), []byte("new\n"), 0o644)
	run("add", "b.txt")
	run("commit", "-q", "-m", "two")
	d2, _, err := ExportSource(ctx, repo, "HEAD", cache)
	if err != nil {
		t.Fatal(err)
	}
	if st, _ := os.Stat(filepath.Join(d2, "a.txt")); !st.ModTime().Equal(past) {
		t.Errorf("unchanged a.txt has mtime %v, want %v", st.ModTime(), past)
	}
	if st, _ := os.Stat(filepath.Join(d2, "b.txt")); !st.ModTime().After(past.Add(time.Hour)) {
		t.Errorf("new b.txt has old mtime %v", st.ModTime())
	}
	// Changed bytes get a fresh mtime.
	os.WriteFile(filepath.Join(repo, "a.txt"), []byte("two\n"), 0o644)
	run("commit", "-q", "-am", "three")
	d3, _, _ := ExportSource(ctx, repo, "HEAD", cache)
	if st, _ := os.Stat(filepath.Join(d3, "a.txt")); !st.ModTime().After(past.Add(time.Hour)) {
		t.Errorf("changed a.txt kept old mtime %v", st.ModTime())
	}
}
