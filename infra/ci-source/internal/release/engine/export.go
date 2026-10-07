package engine

import (
	"archive/tar"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

// KeepExports is how many complete source exports stay in <cache>/src; older
// ones are pruned after an export. The newest is always kept: the next export
// compares file bytes against it to inherit mtimes.
var KeepExports = 5

// beforeFinalize is a test seam: it runs just before the finished tree is
// moved in, where a second process could have finished the same export.
var beforeFinalize func()

// exportMinAge protects an export that was used lately from pruning, so a
// long build of an older commit does not lose its source.
var exportMinAge = time.Hour

// staleTmpAge is how old an abandoned .tmp-* directory must be before it is
// removed (a crashed export; a running one is far younger).
const staleTmpAge = 24 * time.Hour

// ExportMarker is written last into a complete export.
const ExportMarker = ".libreserv-export-complete"

// DefaultCacheDir is ~/.cache/libreserv-release (XDG_CACHE_HOME respected).
func DefaultCacheDir() (string, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(base, "libreserv-release"), nil
}

// ResolveCommit resolves ref to a full commit SHA in repo.
func ResolveCommit(ctx context.Context, repo, ref string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", "-C", repo, "rev-parse", "--verify", "--end-of-options", ref+"^{commit}")
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("resolve %q: %w: %s", ref, err, strings.TrimSpace(errb.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

// ExportSource extracts the tree of commit ref into <cacheDir>/src/<sha> using
// `git archive` (never a worktree, never the checkout). A complete earlier
// export (marker file present) is reused. The returned dir is writable and
// owned by the current user. Safe to call concurrently for the same SHA.
func ExportSource(ctx context.Context, repo, ref, cacheDir string) (dir, sha string, err error) {
	sha, err = ResolveCommit(ctx, repo, ref)
	if err != nil {
		return "", "", err
	}
	root := filepath.Join(cacheDir, "src")
	dir = filepath.Join(root, sha)
	if reuseExport(dir) {
		return dir, sha, nil
	}
	if err := os.MkdirAll(root, 0o755); err != nil {
		return "", "", err
	}
	tmp, err := os.MkdirTemp(root, ".tmp-"+sha[:12]+"-")
	if err != nil {
		return "", "", err
	}
	defer os.RemoveAll(tmp)

	cmd := exec.CommandContext(ctx, "git", "-C", repo, "archive", "--format=tar", sha)
	var errb bytes.Buffer
	cmd.Stderr = &errb
	pipe, err := cmd.StdoutPipe()
	if err != nil {
		return "", "", err
	}
	if err := cmd.Start(); err != nil {
		return "", "", err
	}
	exErr := extractTar(pipe, tmp)
	io.Copy(io.Discard, pipe)
	if werr := cmd.Wait(); werr != nil {
		return "", "", fmt.Errorf("git archive %s: %w: %s", sha, werr, strings.TrimSpace(errb.String()))
	}
	if exErr != nil {
		return "", "", exErr
	}
	if err := inheritMtimes(root, sha, tmp); err != nil {
		return "", "", err
	}
	if err := os.WriteFile(filepath.Join(tmp, ExportMarker), []byte(sha+"\n"), 0o644); err != nil {
		return "", "", err
	}
	// Move the finished tree in under a lock, so two processes exporting the
	// same commit never delete each other's tree: a complete export that
	// appeared meanwhile wins, and only a partial one is replaced.
	if beforeFinalize != nil {
		beforeFinalize()
	}
	unlock, err := lockFile(filepath.Join(root, ".lock-"+sha))
	if err != nil {
		return "", "", err
	}
	defer unlock()
	if reuseExport(dir) {
		return dir, sha, nil // tmp is removed by the deferred RemoveAll
	}
	if _, err := os.Stat(dir); err == nil {
		// Partial or stale: set it aside atomically, then delete it.
		old, err := os.MkdirTemp(root, ".tmp-old-")
		if err != nil {
			return "", "", err
		}
		if err := os.Rename(dir, filepath.Join(old, "x")); err != nil {
			os.Remove(old)
			return "", "", err
		}
		os.RemoveAll(old)
	}
	if err := os.Rename(tmp, dir); err != nil {
		return "", "", err
	}
	cleanExports(root, dir)
	return dir, sha, nil
}

// reuseExport reports whether dir is a complete export, and marks it as used
// just now (so pruning leaves it alone and the next export compares against
// it).
func reuseExport(dir string) bool {
	marker := filepath.Join(dir, ExportMarker)
	if _, err := os.Stat(marker); err != nil {
		return false
	}
	now := time.Now()
	os.Chtimes(marker, now, now)
	return true
}

// lockFile takes an exclusive advisory lock on path (created if needed).
func lockFile(path string) (unlock func(), err error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o644)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX); err != nil {
		f.Close()
		return nil, err
	}
	return func() { syscall.Flock(int(f.Fd()), syscall.LOCK_UN); f.Close() }, nil
}

// cleanExports removes abandoned .tmp-* directories and old lock files, and prunes
// complete exports beyond the newest KeepExports (never keep, never one used
// within exportMinAge). Best effort: failures are ignored.
func cleanExports(root, keep string) {
	ents, err := os.ReadDir(root)
	if err != nil {
		return
	}
	type exp struct {
		path string
		mod  time.Time
	}
	var complete []exp
	now := time.Now()
	for _, e := range ents {
		p := filepath.Join(root, e.Name())
		if !e.IsDir() {
			if strings.HasPrefix(e.Name(), ".lock-") {
				if fi, err := e.Info(); err == nil && now.Sub(fi.ModTime()) > staleTmpAge {
					os.Remove(p)
				}
			}
			continue
		}
		if strings.HasPrefix(e.Name(), ".tmp-") {
			if fi, err := e.Info(); err == nil && now.Sub(fi.ModTime()) > staleTmpAge {
				os.RemoveAll(p)
			}
			continue
		}
		if strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if m, err := os.Stat(filepath.Join(p, ExportMarker)); err == nil {
			complete = append(complete, exp{p, m.ModTime()})
		}
	}
	sort.Slice(complete, func(i, j int) bool { return complete[i].mod.After(complete[j].mod) })
	n := KeepExports
	if n < 1 {
		n = 1
	}
	for i, c := range complete {
		if i < n || c.path == keep || now.Sub(c.mod) < exportMinAge {
			continue
		}
		// Rename first, so nobody sees a half-deleted export.
		gone, err := os.MkdirTemp(root, ".tmp-prune-")
		if err != nil {
			return
		}
		if os.Rename(c.path, filepath.Join(gone, "x")) == nil {
			os.RemoveAll(gone)
		} else {
			os.Remove(gone)
		}
	}
}

// inheritMtimes gives every file of the new export whose bytes equal the same
// path in the newest earlier export that earlier file's mtime. git archive and
// extraction stamp everything with "now", and cargo (and make) compare mtimes,
// so without this a build of the next commit would recompile every workspace
// crate. A file whose bytes differ keeps its new, later mtime, so it is seen
// as changed: this is exact, never a guess from timestamps.
func inheritMtimes(root, sha, tmp string) error {
	ents, err := os.ReadDir(root)
	if err != nil {
		return err
	}
	var prev string
	var prevTime int64
	for _, e := range ents {
		if !e.IsDir() || e.Name() == sha || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		m, err := os.Stat(filepath.Join(root, e.Name(), ExportMarker))
		if err != nil {
			continue
		}
		if t := m.ModTime().UnixNano(); prev == "" || t > prevTime {
			prev, prevTime = filepath.Join(root, e.Name()), t
		}
	}
	if prev == "" {
		return nil
	}
	return filepath.WalkDir(tmp, func(p string, d fs.DirEntry, err error) error {
		if err != nil || !d.Type().IsRegular() {
			return err
		}
		rel, _ := filepath.Rel(tmp, p)
		old := filepath.Join(prev, rel)
		os1, err1 := os.Lstat(old)
		ns, err2 := d.Info()
		if err1 != nil || err2 != nil || !os1.Mode().IsRegular() || os1.Size() != ns.Size() {
			return nil
		}
		if sameBytes(old, p) {
			return os.Chtimes(p, os1.ModTime(), os1.ModTime())
		}
		return nil
	})
}

func sameBytes(a, b string) bool {
	x, err := os.ReadFile(a)
	if err != nil {
		return false
	}
	y, err := os.ReadFile(b)
	return err == nil && bytes.Equal(x, y)
}

// extractTar unpacks a tar stream into dest, refusing paths that escape it.
func extractTar(r io.Reader, dest string) error {
	tr := tar.NewReader(r)
	root := filepath.Clean(dest)
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		if h.Typeflag == tar.TypeXGlobalHeader {
			continue
		}
		target := filepath.Join(root, filepath.FromSlash(h.Name))
		if target != root && !strings.HasPrefix(target, root+string(filepath.Separator)) {
			return fmt.Errorf("tar entry %q escapes the export dir", h.Name)
		}
		mode := os.FileMode(h.Mode).Perm() | 0o200 // always user-writable
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, mode|0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, mode)
			if err != nil {
				return err
			}
			if _, err := io.Copy(f, tr); err != nil {
				f.Close()
				return err
			}
			if err := f.Close(); err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			if err := os.Symlink(h.Linkname, target); err != nil {
				return err
			}
		case tar.TypeLink:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return err
			}
			src := filepath.Join(root, filepath.FromSlash(h.Linkname))
			if err := os.Link(src, target); err != nil {
				return err
			}
		}
	}
}
