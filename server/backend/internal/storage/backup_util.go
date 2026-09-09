package storage

import (
	"archive/tar"
	"compress/gzip"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// isSafeTarPath checks that a tar entry path does not escape the intended
// parent directory. It rejects absolute paths, path traversal (..), and
// paths that — after cleaning — resolve outside the parent.
//
// NOTE: This assumes the host OS uses '/' as its path separator (Linux/macOS).
// Tar archives always store paths with forward slashes per the POSIX spec, and
// filepath.IsAbs / filepath.Separator are OS-dependent. On a Windows host the
// '/'-separated tar entry would need normalisation first. LibreServ targets
// Linux only, so this is not an issue in practice.
func isSafeTarPath(parent, relPath string) bool {
	// Reject absolute paths
	if filepath.IsAbs(relPath) {
		return false
	}
	// Reject path traversal components.
	// We split on both '/' (tar entry separator) and filepath.Separator (OS)
	// so that '..' is caught regardless of platform mismatch.
	for _, part := range strings.FieldsFunc(relPath, func(r rune) bool {
		return r == '/' || r == os.PathSeparator
	}) {
		if part == ".." {
			return false
		}
	}
	// Verify the cleaned, joined path still falls under parent
	joined := filepath.Join(parent, relPath)
	if !strings.HasPrefix(joined, parent+string(filepath.Separator)) && joined != parent {
		return false
	}
	return true
}

// createTarGzFromDir creates a tar.gz archive of a directory into the provided writer.
// It validates that every archive entry path remains within srcDir to prevent
// path traversal attacks (e.g. symlinks pointing outside the source tree).
func createTarGzFromDir(srcDir string, w io.Writer) error {
	gw := gzip.NewWriter(w)
	defer gw.Close()

	tw := tar.NewWriter(gw)
	defer tw.Close()

	// Resolve srcDir to an absolute path for consistent prefix checking
	absSrcDir, err := filepath.Abs(srcDir)
	if err != nil {
		return fmt.Errorf("resolve source dir: %w", err)
	}

	return filepath.Walk(absSrcDir, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return err
		}

		// Resolve symlinks to ensure we don't archive paths outside srcDir
		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return fmt.Errorf("read symlink %s: %w", path, err)
			}
			// Resolve the symlink target relative to its containing directory
			if !filepath.IsAbs(target) {
				target = filepath.Join(filepath.Dir(path), target)
			}
			absTarget, err := filepath.Abs(filepath.Clean(target))
			if err != nil {
				return fmt.Errorf("resolve symlink target: %w", err)
			}
			if !strings.HasPrefix(absTarget, absSrcDir+string(filepath.Separator)) && absTarget != absSrcDir {
				slog.Warn("Skipping tar entry: symlink escapes source directory", "path", path, "target", absTarget)
				return nil
			}
		}

		relPath, err := filepath.Rel(absSrcDir, path)
		if err != nil {
			return fmt.Errorf("relative path for %s: %w", path, err)
		}

		// Verify the relative path is safe (no traversal)
		if !isSafeTarPath(absSrcDir, relPath) {
			slog.Warn("Skipping tar entry: path traversal detected", "path", path, "relPath", relPath)
			return nil
		}

		header, err := tar.FileInfoHeader(info, "")
		if err != nil {
			return fmt.Errorf("tar header for %s: %w", path, err)
		}

		header.Name = relPath

		if err := tw.WriteHeader(header); err != nil {
			return fmt.Errorf("write header: %w", err)
		}

		if !info.IsDir() {
			f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
			if err != nil {
				return err
			}
			defer f.Close()
			if _, err := io.Copy(tw, f); err != nil {
				return fmt.Errorf("copy %s: %w", path, err)
			}
		}

		return nil
	})
}
