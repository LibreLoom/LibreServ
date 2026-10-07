package main

import (
	"flag"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func quiet(t *testing.T) {
	t.Helper()
	old := os.Stderr
	f, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	os.Stderr = f
	t.Cleanup(func() { os.Stderr = old; f.Close() })
}

func TestParseInterspersed(t *testing.T) {
	quiet(t)
	fs := flag.NewFlagSet("x", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	ref := fs.String("ref", "", "")
	dry := fs.Bool("dry-run", false, "")
	pos, err := parseInterspersed(fs, []string{"luna", "--ref", "main", "extra", "--dry-run"})
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(pos, []string{"luna", "extra"}) || *ref != "main" || !*dry {
		t.Fatalf("pos %v ref %q dry %v", pos, *ref, *dry)
	}
	if _, err := parseInterspersed(flag.NewFlagSet("y", flag.ContinueOnError), []string{"--nope"}); err == nil {
		t.Fatal("unknown flag accepted")
	}
}

func TestParseSecretID(t *testing.T) {
	for in, want := range map[string]string{"sol": "libreserv-signing", "Luna": "lsluna-signing", "forgejo": "forgejo-token", "android": "android-keystore"} {
		got, err := parseID(in)
		if err != nil || string(got) != want {
			t.Errorf("%s -> %s, %v", in, got, err)
		}
	}
	if _, err := parseID("nope"); err == nil {
		t.Error("unknown id accepted")
	}
}

func TestRunDispatch(t *testing.T) {
	quiet(t)
	repoFlag = ""
	if got := run([]string{"bogus"}); got != 2 {
		t.Errorf("unknown command: %d", got)
	}
	if got := run([]string{"--repo"}); got != 2 {
		t.Errorf("--repo without value: %d", got)
	}
	if got := run([]string{"build"}); got != 2 {
		t.Errorf("build without unit: %d", got)
	}
	if got := run([]string{"cut", "luna"}); got != 2 {
		t.Errorf("cut without channel: %d", got)
	}
	if got := run([]string{"verify"}); got != 2 {
		t.Errorf("verify without unit: %d", got)
	}
	if got := run([]string{"help"}); got != 0 {
		t.Errorf("help: %d", got)
	}
	repoFlag = ""
}

func TestRepoFlag(t *testing.T) {
	dir := t.TempDir()
	run([]string{"--repo=" + dir, "help"})
	if repoFlag != dir {
		t.Fatalf("repoFlag %q", repoFlag)
	}
	got, err := repoRoot()
	if err != nil || got != dir {
		t.Fatalf("repoRoot %q %v", got, err)
	}
	if abs := absOut("dist"); abs != filepath.Join(dir, "dist") {
		t.Fatalf("absOut %q", abs)
	}
	repoFlag = ""
}
