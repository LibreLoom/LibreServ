package engine

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
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

// HashDir returns a short content hash of every file in dir (relative names,
// modes' exec bit, and bytes), so an image rebuilds exactly when its
// Containerfile or anything it copies changes.
func HashDir(dir string) (string, error) {
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
		return "", err
	}
	if len(files) == 0 {
		return "", fmt.Errorf("%s: empty image dir", dir)
	}
	sort.Strings(files)
	h := sha256.New()
	for _, rel := range files {
		fi, err := os.Stat(filepath.Join(dir, rel))
		if err != nil {
			return "", err
		}
		b, err := os.ReadFile(filepath.Join(dir, rel))
		if err != nil {
			return "", err
		}
		exec := byte('-')
		if fi.Mode()&0o111 != 0 {
			exec = 'x'
		}
		fmt.Fprintf(h, "%s\x00%c\x00%d\x00", filepath.ToSlash(rel), exec, len(b))
		h.Write(b)
	}
	return hex.EncodeToString(h.Sum(nil))[:12], nil
}

// Image is one toolchain image defined by <ImagesDir>/<Name>/Containerfile.
type Image struct {
	Name string
	Dir  string
	Hash string
	// RunOpts are extra `podman run` args (the flatpak image's bwrap options).
	RunOpts []string
}

// Ref is the local image reference, libreserv-release/<name>:<hash>.
func (i Image) Ref() string { return ImageRepo + "/" + i.Name + ":" + i.Hash }

// LoadImage reads one image dir.
func LoadImage(imagesDir, name string) (Image, error) {
	if name == "" || strings.ContainsAny(name, "/\\") || strings.HasPrefix(name, ".") {
		return Image{}, fmt.Errorf("bad image name %q", name)
	}
	dir := filepath.Join(imagesDir, name)
	if _, err := os.Stat(filepath.Join(dir, "Containerfile")); err != nil {
		return Image{}, fmt.Errorf("image %q: %w", name, err)
	}
	hash, err := HashDir(dir)
	if err != nil {
		return Image{}, err
	}
	img := Image{Name: name, Dir: dir, Hash: hash}
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
