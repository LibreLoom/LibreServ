package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func auditRepo(t *testing.T) (repo, head string) {
	t.Helper()
	gitEnv(t)
	repo = t.TempDir()
	git(t, repo, "init", "-q", "-b", "main")
	must(t, os.WriteFile(filepath.Join(repo, "a.txt"), []byte("a\n"), 0o644))
	git(t, repo, "add", ".")
	git(t, repo, "commit", "-q", "-m", "init")
	return repo, git(t, repo, "rev-parse", "HEAD")
}

func TestParseAuditHash(t *testing.T) {
	h := strings.Repeat("ab", 20)
	for in, ok := range map[string]bool{
		h:                       true,
		h + "\n":                true,
		h + "\n\n":              false,
		h + "\n" + h + "\n":     false,
		" " + h:                 false,
		strings.ToUpper(h):      false,
		h[:39]:                  false,
		h + "0":                 false,
		"":                      false,
		strings.Repeat("g", 40): false,
	} {
		if got, gotOK := parseAuditHash([]byte(in)); gotOK != ok || (ok && got != h) {
			t.Errorf("parseAuditHash(%q) = %q, %v; want ok=%v", in, got, gotOK, ok)
		}
	}
}

func TestCheckReleaseAudit(t *testing.T) {
	ctx := context.Background()
	repo, head := auditRepo(t)
	file := filepath.Join(t.TempDir(), "LIBRESERV_RELEASE_AUDIT_COMPLETE")

	expect := func(name, want string) {
		t.Helper()
		err := CheckReleaseAudit(ctx, repo, file)
		if want == "" {
			if err != nil {
				t.Errorf("%s: %v", name, err)
			}
			return
		}
		if err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: err %v, want %q", name, err, want)
		}
		if err != nil && !strings.Contains(err.Error(), "/release-audit") {
			t.Errorf("%s: message does not say to run /release-audit: %v", name, err)
		}
	}

	expect("missing", "no release audit")

	must(t, os.WriteFile(file, []byte(head+"\n"), 0o600))
	expect("good", "")
	must(t, os.WriteFile(file, []byte(head), 0o600))
	expect("good without newline", "")

	must(t, os.WriteFile(file, []byte("not a hash\n"), 0o600))
	expect("garbage", "not valid")
	must(t, os.WriteFile(file, []byte(head+"\n"+head+"\n"), 0o600))
	expect("two hashes", "not valid")
	must(t, os.WriteFile(file, []byte(head[:12]+"\n"), 0o600))
	expect("short hash", "not valid")

	must(t, os.WriteFile(file, []byte(strings.Repeat("0", 40)+"\n"), 0o600))
	expect("other commit", "but the checkout is at "+head)

	// A link to a valid marker does not count.
	real := filepath.Join(t.TempDir(), "real")
	must(t, os.WriteFile(real, []byte(head+"\n"), 0o600))
	must(t, os.Remove(file))
	must(t, os.Symlink(real, file))
	expect("symlink", "not a plain file")
	must(t, os.Remove(file))
	must(t, os.WriteFile(file, []byte(head+"\n"), 0o600))

	// A new commit makes the old audit stale.
	must(t, os.WriteFile(filepath.Join(repo, "b.txt"), []byte("b\n"), 0o644))
	git(t, repo, "add", ".")
	git(t, repo, "commit", "-q", "-m", "second")
	expect("stale after a new commit", "the release audit is for commit "+head)
	head = git(t, repo, "rev-parse", "HEAD")
	must(t, os.WriteFile(file, []byte(head+"\n"), 0o600))
	expect("audited again", "")

	// Dirty trees fail, untracked files included.
	must(t, os.WriteFile(filepath.Join(repo, "a.txt"), []byte("changed\n"), 0o644))
	expect("modified file", "uncommitted or untracked")
	git(t, repo, "checkout", "-q", "--", "a.txt")
	must(t, os.WriteFile(filepath.Join(repo, "new.go"), []byte("package x\n"), 0o644))
	expect("untracked file", "uncommitted or untracked")
	must(t, os.Remove(filepath.Join(repo, "new.go")))
	expect("clean again", "")
}

func TestPreflightChecksReleaseAudit(t *testing.T) {
	w := newWorld(t)
	file := filepath.Join(t.TempDir(), "audit")
	w.app.cfg.AuditFile = file
	req := CutRequest{Unit: "fake", Channel: "stable", Bump: "minor"}

	state := func() (string, string) {
		rep := w.app.Preflight(context.Background(), req)
		for _, c := range rep.Checks {
			if c.Name == "release audit" {
				return c.State, c.Detail
			}
		}
		t.Fatalf("no release audit check in %+v", rep.Checks)
		return "", ""
	}
	if st, d := state(); st != CheckFail || !strings.Contains(d, "/release-audit") {
		t.Fatalf("missing marker: %s %s", st, d)
	}
	must(t, os.WriteFile(file, []byte(git(t, w.repo, "rev-parse", "HEAD")+"\n"), 0o600))
	if st, d := state(); st != CheckOK {
		t.Fatalf("valid marker: %s %s", st, d)
	}
	must(t, os.WriteFile(file, []byte(strings.Repeat("1", 40)+"\n"), 0o600))
	if st, _ := state(); st != CheckFail {
		t.Fatalf("marker for another commit passed")
	}
	if _, err := w.app.Cut(context.Background(), req); err == nil {
		t.Fatal("cut ran without a valid release audit")
	}
}
