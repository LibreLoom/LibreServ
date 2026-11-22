package app

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"syscall"
)

// DefaultAuditFile is where the release-audit skill (/release-audit in Claude
// Code, .claude/skills/release-audit) records the commit it audited and found
// nothing blocking in. The cut preflight shows it as the "clean tree" and
// "release audit" rows and blocks a cut on them, in the TUI and the CLI alike.
// The root ./release launcher does not gate on it, so the tool still opens.
const DefaultAuditFile = "/tmp/LIBRESERV_RELEASE_AUDIT_COMPLETE"

// auditHint ends every audit failure.
const auditHint = "Run /release-audit in Claude Code on this commit, then try again."

// CheckReleaseAudit returns nil when file names the repo's HEAD commit: it is
// a regular file owned by this user (not a link), holding exactly one full
// 40-character lower-case hex hash (one trailing newline allowed), equal to
// `git rev-parse HEAD`, and the working tree is clean, untracked files
// included.
func CheckReleaseAudit(ctx context.Context, repo, file string) error {
	if err := CheckCleanTree(ctx, repo); err != nil {
		return err
	}
	return CheckAuditFile(ctx, repo, file)
}

// CheckCleanTree returns nil when the working tree has no uncommitted or
// untracked changes. It is its own preflight row so the reason and the fix
// show up next to the audit row.
func CheckCleanTree(ctx context.Context, repo string) error {
	status, err := gitOut(ctx, repo, "status", "--porcelain")
	if err != nil {
		return fmt.Errorf("cannot read the working tree: %v", err)
	}
	if status != "" {
		return errors.New("uncommitted or untracked changes. Commit or remove them, then run /release-audit in Claude Code on that commit")
	}
	return nil
}

// CheckAuditFile is CheckReleaseAudit without the clean-tree test: the
// marker file must be a regular file owned by this user, hold exactly one
// full hash, and name the repo's HEAD.
func CheckAuditFile(ctx context.Context, repo, file string) error {
	head, err := gitOut(ctx, repo, "rev-parse", "--verify", "HEAD")
	if err != nil {
		return fmt.Errorf("cannot read the current commit: %v. %s", err, auditHint)
	}
	st, err := os.Lstat(file)
	if errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("no release audit for this commit. %s", auditHint)
	}
	if err != nil {
		return fmt.Errorf("cannot read %s: %v. %s", file, err, auditHint)
	}
	if !st.Mode().IsRegular() {
		return fmt.Errorf("%s is not a plain file, so it does not count as an audit. %s", file, auditHint)
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok && int(sys.Uid) != os.Getuid() {
		return fmt.Errorf("%s belongs to another user, so it does not count as an audit. %s", file, auditHint)
	}
	b, err := os.ReadFile(file)
	if err != nil {
		return fmt.Errorf("cannot read %s: %v. %s", file, err, auditHint)
	}
	audited, ok := parseAuditHash(b)
	if !ok {
		return fmt.Errorf("%s is not valid: it must hold exactly one full commit hash. %s", file, auditHint)
	}
	if audited != head {
		return fmt.Errorf("the release audit is for commit %s, but the checkout is at %s. %s", audited, head, auditHint)
	}
	return nil
}

// parseAuditHash accepts exactly 40 lower-case hex characters, optionally
// followed by one newline.
func parseAuditHash(b []byte) (string, bool) {
	s := strings.TrimSuffix(string(b), "\n")
	if len(s) != 40 {
		return "", false
	}
	for _, c := range s {
		if (c < '0' || c > '9') && (c < 'a' || c > 'f') {
			return "", false
		}
	}
	return s, true
}

func gitOut(ctx context.Context, dir string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) && len(ee.Stderr) > 0 {
			return "", errors.New(strings.TrimSpace(string(ee.Stderr)))
		}
		return "", err
	}
	return strings.TrimSpace(string(out)), nil
}
