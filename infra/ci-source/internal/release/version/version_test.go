package version

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestParseStrict(t *testing.T) {
	good := []string{"0.1.6", "1.2.3", "0.3.0-beta.2", "0.4.1-0.dev.12", "10.20.30"}
	for _, s := range good {
		v, err := Parse(s)
		if err != nil || v.String() != s {
			t.Errorf("Parse(%q) = %v, %v", s, v, err)
		}
	}
	bad := []string{"", "v1.2.3", "1.2", "01.2.3", "1.2.3+build", "1.2.3-", "1.2.3-beta.01", "1.2.x", "1.2.3-be ta", "1.2.3-.x"}
	for _, s := range bad {
		if _, err := Parse(s); err == nil {
			t.Errorf("Parse(%q) should fail", s)
		}
	}
}

func TestCompare(t *testing.T) {
	order := []string{
		"0.3.0-0.dev.5", "0.3.0-beta.2", "0.3.0-beta.10", "0.3.0-rc", "0.3.0", "0.3.1-0.dev.1", "0.3.1", "0.10.0", "1.0.0",
	}
	for i := range order {
		for j := range order {
			got, err := Compare(order[i], order[j])
			if err != nil {
				t.Fatal(err)
			}
			want := cmpInt(i, j)
			if got != want {
				t.Errorf("Compare(%s, %s) = %d, want %d", order[i], order[j], got, want)
			}
		}
	}
}

func TestDev(t *testing.T) {
	cases := []struct {
		last string
		n    int
		want string
	}{
		{"0.4.0", 12, "0.4.1-0.dev.12"},
		{"0.4.0", 0, "0.4.1-0.dev.0"},
		{"0.4.0-beta.2", 3, "0.4.0-0.dev.3"},
	}
	for _, c := range cases {
		got := Dev(MustParse(c.last), c.n)
		if got.String() != c.want {
			t.Errorf("Dev(%s,%d) = %s, want %s", c.last, c.n, got, c.want)
		}
	}
	// Dev sorts below every beta and the release of the version it targets.
	d := Dev(MustParse("0.4.0"), 99)
	for _, s := range []string{"0.4.1-beta.1", "0.4.1"} {
		if !d.Less(MustParse(s)) {
			t.Errorf("%s should be below %s", d, s)
		}
	}
	if !MustParse("0.4.0").Less(d) {
		t.Errorf("last release should be below its dev build")
	}
}

func TestAndroidVersionCode(t *testing.T) {
	cases := []struct {
		v    string
		want int
		err  bool
	}{
		{"0.1.6", 10699, false},
		{"0.1.6-beta.1", 10601, false},
		{"0.1.6-beta.98", 10698, false},
		{"1.2.3", 1020399, false},
		{"0.1.6-beta.99", 0, true},
		{"0.1.6-beta.0", 0, true},
		{"0.1.7-0.dev.3", 0, true},
		{"0.1.6-rc.1", 0, true},
		{"0.100.0", 0, true},
	}
	for _, c := range cases {
		got, err := MustParse(c.v).AndroidVersionCode()
		if (err != nil) != c.err || got != c.want {
			t.Errorf("%s: got %d, %v; want %d err=%v", c.v, got, err, c.want, c.err)
		}
	}
	b, _ := MustParse("0.1.6-beta.5").AndroidVersionCode()
	f, _ := MustParse("0.1.6").AndroidVersionCode()
	if b >= f {
		t.Error("beta code must be below the release code")
	}
}

func TestNext(t *testing.T) {
	cases := []struct{ from, kind, want string }{
		{"0.4.0", "patch", "0.4.1"},
		{"0.4.0", "minor", "0.5.0"},
		{"0.4.3", "major", "1.0.0"},
		{"0.4.0", "beta", "0.4.1-beta.1"},
		{"0.4.1-beta.1", "beta", "0.4.1-beta.2"},
		{"0.4.1-beta.2", "patch", "0.4.1"},
	}
	for _, c := range cases {
		got, err := MustParse(c.from).Next(c.kind)
		if err != nil || got.String() != c.want {
			t.Errorf("%s %s = %v, %v; want %s", c.from, c.kind, got, err, c.want)
		}
	}
}

func TestTag(t *testing.T) {
	v := MustParse("0.4.0")
	if got := Tag("luna", v); got != "luna/v0.4.0" {
		t.Fatal(got)
	}
	u, pv, err := ParseTag("luna-desktop/v0.4.0-beta.2")
	if err != nil || u != "luna-desktop" || pv.String() != "0.4.0-beta.2" {
		t.Fatal(u, pv, err)
	}
	if _, _, err := ParseTag("v1.2.3"); err == nil {
		t.Fatal("old-style tag should not parse")
	}
}

func TestReadFile(t *testing.T) {
	p := filepath.Join(t.TempDir(), "VERSION")
	os.WriteFile(p, []byte("0.1.6\n"), 0o644)
	v, err := ReadFile(p)
	if err != nil || v.String() != "0.1.6" {
		t.Fatal(v, err)
	}
	os.WriteFile(p, []byte("v0.1.6\n"), 0o644)
	if _, err := ReadFile(p); err == nil {
		t.Fatal("leading v must fail")
	}
}

func TestDevVersionGit(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("no git")
	}
	repo := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", append([]string{"-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false"}, args...)...)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	run("init", "-q", "-b", "main")
	os.MkdirAll(filepath.Join(repo, "luna"), 0o755)
	os.WriteFile(filepath.Join(repo, "luna/VERSION"), []byte("0.3.0\n"), 0o644)
	run("add", ".")
	run("commit", "-q", "-m", "one")
	ctx := context.Background()

	// No tag yet: VERSION is the base, every commit counts.
	v, err := DevVersion(ctx, repo, "luna", "HEAD")
	if err != nil || v.String() != "0.3.1-0.dev.1" {
		t.Fatalf("no tag: %v %v", v, err)
	}
	run("tag", "luna/v0.3.0")
	run("tag", "luna/v0.2.9")
	run("tag", "sol/v9.9.9")
	for _, m := range []string{"two", "three"} {
		os.WriteFile(filepath.Join(repo, "f"), []byte(m), 0o644)
		run("add", ".")
		run("commit", "-q", "-m", m)
	}
	v, err = DevVersion(ctx, repo, "luna", "HEAD")
	if err != nil || v.String() != "0.3.1-0.dev.2" {
		t.Fatalf("tagged: %v %v", v, err)
	}
}
