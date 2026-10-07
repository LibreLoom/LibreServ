package publish

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// Git runs git in Dir. It never prompts, and scrubs credentials out of errors.
type Git struct {
	Dir string
}

var credRE = regexp.MustCompile(`(://)[^/@\s]+@`)

func scrub(s string) string { return credRE.ReplaceAllString(s, "${1}***@") }

func (g Git) run(ctx context.Context, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", args...)
	cmd.Dir = g.Dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_EDITOR=true", "LC_ALL=C")
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w: %s", scrub(strings.Join(args, " ")), err, scrub(strings.TrimSpace(errb.String())))
	}
	return strings.TrimSpace(out.String()), nil
}

// Rev resolves a revision to a commit SHA.
func (g Git) Rev(ctx context.Context, rev string) (string, error) {
	return g.run(ctx, "rev-parse", "--verify", "-q", rev+"^{commit}")
}

// HasCommit reports whether the commit object exists locally.
func (g Git) HasCommit(ctx context.Context, sha string) bool {
	_, err := g.run(ctx, "cat-file", "-e", sha+"^{commit}")
	return err == nil
}

// Preflight checks the repository is ready for a cut: clean tree, on branch,
// nothing unpushed, and the tag free locally and on every remote given.
func (g Git) Preflight(ctx context.Context, branch, tag string, remotes ...string) error {
	if st, err := g.run(ctx, "status", "--porcelain", "--untracked-files=no"); err != nil {
		return err
	} else if st != "" {
		return errors.New("working tree is not clean")
	}
	if cur, err := g.run(ctx, "symbolic-ref", "--short", "-q", "HEAD"); err != nil || cur != branch {
		return fmt.Errorf("not on %s (on %q)", branch, cur)
	}
	if _, err := g.Rev(ctx, "refs/tags/"+tag); err == nil {
		return fmt.Errorf("tag %s already exists locally", tag)
	}
	for _, r := range remotes {
		out, err := g.run(ctx, "ls-remote", "--tags", r, "refs/tags/"+tag)
		if err != nil {
			return err
		}
		if out != "" {
			return fmt.Errorf("tag %s already exists on %s", tag, r)
		}
	}
	return nil
}

func (g Git) identity(ctx context.Context) []string {
	name, _ := g.run(ctx, "config", "user.name")
	email, _ := g.run(ctx, "config", "user.email")
	var a []string
	if name == "" {
		name = "LibreServ release"
	}
	if email == "" {
		email = "release@libreserv.invalid"
	}
	a = append(a, "-c", "user.name="+name, "-c", "user.email="+email)
	return a
}

const pushAttempts = 5

// Bump makes the release commit and pushes it to remote/branch.
//
// apply writes VERSION etc. into the directory it is given (g.Dir) and returns
// the changed paths relative to it. When the push is rejected because the
// branch moved, Bump fetches, rebases the commit and tries again (nothing is
// built yet, so the SHA may still change). A commit with the same subject that
// is already on remote/branch, or committed locally but not pushed yet, is
// reused: that is what makes the step safe to repeat.
//
// With push=false nothing leaves the machine and no fetch happens.
func (g Git) Bump(ctx context.Context, remote, branch, subject string, push bool, apply func(dir string) ([]string, error)) (string, error) {
	upstream := remote + "/" + branch
	if push {
		if _, err := g.run(ctx, "fetch", "--quiet", remote, "+refs/heads/"+branch+":refs/remotes/"+upstream); err != nil {
			return "", err
		}
	}
	// Already made? Look at what is not on the upstream yet, then at upstream.
	if sha, err := g.findSubject(ctx, upstream+"..HEAD", subject); err == nil && sha != "" {
		return g.pushBump(ctx, remote, branch, push)
	}
	if push {
		if sha, err := g.findSubject(ctx, upstream, subject); err == nil && sha != "" {
			return sha, nil
		}
	}
	if push {
		n, err := g.run(ctx, "rev-list", "--count", upstream+"..HEAD")
		if err != nil {
			return "", err
		}
		if n != "0" {
			return "", fmt.Errorf("%s has %s local commit(s) that are not on %s; push or drop them before a cut", branch, n, upstream)
		}
	}
	paths, err := apply(g.Dir)
	if err != nil {
		return "", err
	}
	if len(paths) == 0 {
		return "", errors.New("bump changed nothing")
	}
	if _, err := g.run(ctx, append([]string{"add", "--"}, paths...)...); err != nil {
		return "", err
	}
	if st, err := g.run(ctx, append([]string{"status", "--porcelain", "--"}, paths...)...); err != nil {
		return "", err
	} else if st == "" {
		return "", errors.New("bump changed nothing (version already set?)")
	}
	commit := append(g.identity(ctx), "commit", "--quiet", "-m", subject, "--")
	if _, err := g.run(ctx, append(commit, paths...)...); err != nil {
		return "", err
	}
	return g.pushBump(ctx, remote, branch, push)
}

func (g Git) findSubject(ctx context.Context, rng, subject string) (string, error) {
	out, err := g.run(ctx, "log", "-n", "200", "--format=%H%x09%s", rng)
	if err != nil {
		return "", err
	}
	for _, l := range strings.Split(out, "\n") {
		if sha, s, ok := strings.Cut(l, "\t"); ok && s == subject {
			return sha, nil
		}
	}
	return "", nil
}

func (g Git) pushBump(ctx context.Context, remote, branch string, push bool) (string, error) {
	if !push {
		return g.Rev(ctx, "HEAD")
	}
	var lastErr error
	for i := 0; i < pushAttempts; i++ {
		if _, lastErr = g.run(ctx, "push", "--quiet", remote, "HEAD:refs/heads/"+branch); lastErr == nil {
			return g.Rev(ctx, "HEAD")
		}
		if _, err := g.run(ctx, "fetch", "--quiet", remote, "+refs/heads/"+branch+":refs/remotes/"+remote+"/"+branch); err != nil {
			return "", err
		}
		if _, err := g.run(ctx, append(g.identity(ctx), "rebase", "--quiet", remote+"/"+branch)...); err != nil {
			g.run(ctx, "rebase", "--abort")
			return "", fmt.Errorf("main moved and the release commit does not rebase: %w", err)
		}
	}
	return "", fmt.Errorf("push to %s kept failing: %w", remote, lastErr)
}

// FeedFile is one file on the feeds branch.
type FeedFile struct {
	Path string // relative to the branch root, slash separated
	Data []byte
}

const feedsReadme = "# Release feeds\n\nSigned release feeds, one commit per release. Written only by the release tool.\nSee infra/docs/RELEASE-PLAN.md (Feeds).\n"

// CommitFeeds adds one commit to the feeds branch in a throwaway clone (the
// caller's working tree and index are never touched) and pushes it to
// remote. plan gets a reader for files currently on the branch (nil, nil when
// absent) and returns the files to write; it runs again on every retry so it
// always sees what is really on the branch. A plan that changes nothing makes
// no commit and returns the existing tip, which is what makes the step
// repeatable. With push=false the clone is dropped after the commit.
func (g Git) CommitFeeds(ctx context.Context, remote, branch, message string, push bool,
	plan func(read func(rel string) ([]byte, error)) ([]FeedFile, error)) (string, []FeedFile, error) {
	var lastErr error
	for i := 0; i < pushAttempts; i++ {
		sha, files, retry, err := g.commitFeedsOnce(ctx, remote, branch, message, push, plan)
		if err == nil {
			return sha, files, nil
		}
		lastErr = err
		if !retry {
			break
		}
	}
	return "", nil, lastErr
}

func (g Git) commitFeedsOnce(ctx context.Context, remote, branch, message string, push bool,
	plan func(read func(rel string) ([]byte, error)) ([]FeedFile, error)) (sha string, files []FeedFile, retry bool, err error) {
	url, err := g.run(ctx, "remote", "get-url", remote)
	if err != nil {
		return "", nil, false, err
	}
	tmp, err := os.MkdirTemp("", "libreserv-feeds-")
	if err != nil {
		return "", nil, false, err
	}
	defer os.RemoveAll(tmp)
	t := Git{Dir: tmp}
	id := g.identity(ctx)

	heads, err := g.run(ctx, "ls-remote", "--heads", remote, "refs/heads/"+branch)
	if err != nil {
		return "", nil, false, err
	}
	if heads != "" {
		// Clone from the URL; a relative path is relative to the repo.
		if _, err := g.run(ctx, "clone", "--quiet", "--single-branch", "--no-tags", "--branch", branch, url, tmp); err != nil {
			return "", nil, false, err
		}
	} else {
		if _, err := t.run(ctx, "init", "--quiet"); err != nil {
			return "", nil, false, err
		}
		if _, err := t.run(ctx, "checkout", "--quiet", "--orphan", branch); err != nil {
			return "", nil, false, err
		}
	}
	read := func(rel string) ([]byte, error) {
		b, err := os.ReadFile(filepath.Join(tmp, filepath.FromSlash(rel)))
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return b, err
	}
	files, err = plan(read)
	if err != nil {
		return "", nil, false, err
	}
	if _, err := os.Stat(filepath.Join(tmp, "README.md")); err != nil {
		files = append([]FeedFile{{Path: "README.md", Data: []byte(feedsReadme)}}, files...)
	}
	for _, f := range files {
		p := filepath.Join(tmp, filepath.FromSlash(f.Path))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			return "", nil, false, err
		}
		if err := os.WriteFile(p, f.Data, 0o644); err != nil {
			return "", nil, false, err
		}
	}
	if _, err := t.run(ctx, "add", "-A"); err != nil {
		return "", nil, false, err
	}
	st, err := t.run(ctx, "status", "--porcelain")
	if err != nil {
		return "", nil, false, err
	}
	if st != "" {
		if _, err := t.run(ctx, append(id, "commit", "--quiet", "-m", message)...); err != nil {
			return "", nil, false, err
		}
	}
	sha, err = t.Rev(ctx, "HEAD")
	if err != nil {
		return "", nil, false, err
	}
	if push && st != "" {
		if _, err := t.run(ctx, "push", "--quiet", url, "HEAD:refs/heads/"+branch); err != nil {
			return "", nil, true, err
		}
	}
	return sha, files, false, nil
}

// PushTag creates the tag at sha locally and pushes it to remote. Repeating
// it is fine; a tag that points somewhere else is an error.
func (g Git) PushTag(ctx context.Context, remote, tag, sha string) error {
	ref := "refs/tags/" + tag
	if cur, err := g.Rev(ctx, ref); err == nil {
		if cur != sha {
			return fmt.Errorf("tag %s already points at %s, not the release commit %s", tag, cur, sha)
		}
	} else if _, err := g.run(ctx, "tag", tag, sha); err != nil {
		return err
	}
	out, err := g.run(ctx, "ls-remote", remote, ref)
	if err != nil {
		return err
	}
	if out != "" {
		if strings.HasPrefix(out, sha) {
			return nil
		}
		return fmt.Errorf("tag %s already exists on %s at a different commit", tag, remote)
	}
	_, err = g.run(ctx, "push", "--quiet", remote, ref+":"+ref)
	return err
}
