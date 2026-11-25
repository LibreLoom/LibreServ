package engine

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// ImageRepo is the local repository all toolchain images are tagged under:
// libreserv-release/<name>:<content-hash>.
const ImageRepo = "libreserv-release"

// RunOptsFile, when present in an image dir, lists extra `podman run`
// arguments for jobs in that image (one per line; blank lines and # comments
// ignored). It is part of the content hash.
const RunOptsFile = "run-options"

// ContextFile, when present in an image dir, holds the build context to hand
// to podman: one path, relative to the image dir. Without it the context is
// the image dir itself, which is right for a self-contained image. An image
// whose Containerfile lives in the source tree (luna-os builds the kernel
// beside it) needs a real context, because podman cannot copy a file through
// a symlink that points outside the context.
const ContextFile = "context"

// HashDir returns a short content hash of every file in dir (relative names,
// modes' exec bit, and bytes), so an image rebuilds exactly when its
// Containerfile or anything it copies changes.
func HashDir(dir string) (string, error) { return hashDirs([]string{dir}) }

// hashDirs hashes several directories into one content hash, each prefixed by
// its position so the same bytes in two dirs do not look like one dir. Paths
// are left out of the hash, so moving the checkout does not rebuild images.
func hashDirs(dirs []string) (string, error) {
	h := sha256.New()
	for i, dir := range dirs {
		if i > 0 && filepath.Clean(dir) == filepath.Clean(dirs[0]) {
			continue
		}
		fmt.Fprintf(h, "\x01dir\x00%d\x00", i)
		if err := hashDirInto(h, dir); err != nil {
			return "", err
		}
	}
	return hex.EncodeToString(h.Sum(nil))[:12], nil
}

// hashDirInto appends one directory's files to h.
func hashDirInto(h hash.Hash, dir string) error {
	var files []string
	err := filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			rel, err := filepath.Rel(dir, p)
			if err != nil {
				return err
			}
			files = append(files, rel)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return fmt.Errorf("%s: empty image dir", dir)
	}
	sort.Strings(files)
	for _, rel := range files {
		fi, err := os.Stat(filepath.Join(dir, rel))
		if err != nil {
			return err
		}
		b, err := os.ReadFile(filepath.Join(dir, rel))
		if err != nil {
			return err
		}
		exec := byte('-')
		if fi.Mode()&0o111 != 0 {
			exec = 'x'
		}
		fmt.Fprintf(h, "%s\x00%c\x00%d\x00", filepath.ToSlash(rel), exec, len(b))
		h.Write(b)
	}
	return nil
}

// Image is one toolchain image defined by <ImagesDir>/<Name>/Containerfile.
type Image struct {
	Name string
	Dir  string
	// Context is the build context given to podman build (usually Dir; see
	// ContextFile). The Containerfile is always read from Dir.
	Context string
	Hash    string
	// RunOpts are extra `podman run` args (the flatpak image's bwrap options).
	RunOpts []string
}

// Ref is the local image reference, libreserv-release/<name>:<hash>.
func (i Image) Ref() string { return ImageRepo + "/" + i.Name + ":" + i.Hash }

// contextPath is the one path a ContextFile names: blank lines and `#`
// comments are for the reader, not the build.
func contextPath(body string) string {
	for _, line := range strings.Split(body, "\n") {
		s := strings.TrimSpace(line)
		if s != "" && !strings.HasPrefix(s, "#") {
			return s
		}
	}
	return ""
}

// LoadImage reads one image dir.
func LoadImage(imagesDir, name string) (Image, error) {
	if name == "" || strings.ContainsAny(name, "/\\") || strings.HasPrefix(name, ".") {
		return Image{}, fmt.Errorf("bad image name %q", name)
	}
	dir := filepath.Join(imagesDir, name)
	if _, err := os.Stat(filepath.Join(dir, "Containerfile")); err != nil {
		return Image{}, fmt.Errorf("image %q: %w", name, err)
	}
	ctx := dir
	if b, err := os.ReadFile(filepath.Join(dir, ContextFile)); err == nil {
		rel := contextPath(string(b))
		if rel == "" {
			return Image{}, fmt.Errorf("image %q: empty %s", name, ContextFile)
		}
		ctx = filepath.Join(dir, rel)
		fi, err := os.Stat(ctx)
		if err != nil {
			return Image{}, fmt.Errorf("image %q: %w", name, err)
		}
		if !fi.IsDir() {
			return Image{}, fmt.Errorf("image %q: %s is not a directory", name, ContextFile)
		}
	}
	hash, err := hashDirs([]string{dir, ctx})
	if err != nil {
		return Image{}, err
	}
	img := Image{Name: name, Dir: dir, Context: ctx, Hash: hash}
	if b, err := os.ReadFile(filepath.Join(dir, RunOptsFile)); err == nil {
		img.RunOpts = parseRunOpts(string(b))
	}
	return img, nil
}

func parseRunOpts(s string) []string {
	var out []string
	for _, line := range strings.Split(s, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		out = append(out, strings.Fields(line)...)
	}
	return out
}

// ListImages loads every image dir under imagesDir, sorted by name.
func ListImages(imagesDir string) ([]Image, error) {
	ents, err := os.ReadDir(imagesDir)
	if err != nil {
		return nil, err
	}
	var imgs []Image
	for _, e := range ents {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		img, err := LoadImage(imagesDir, e.Name())
		if err != nil {
			return nil, err
		}
		imgs = append(imgs, img)
	}
	return imgs, nil
}
