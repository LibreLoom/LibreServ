package secrets

import (
	"bytes"
	"context"
	"encoding/base64"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var keystoreExts = map[string]bool{".jks": true, ".keystore": true, ".p12": true, ".pfx": true}

// scan roots we never descend into during the home scan: huge, or caches full
// of files that can never be a key.
var scanSkip = map[string]bool{
	"node_modules": true, "vendor": true, "target": true, "go": true, "snap": true,
	"__pycache__": true, "build": true, "dist": true, "Steam": true, "venv": true,
}

const (
	maxKeyFileSize      = 2048
	minKeyFileSize      = 100
	maxKeystoreFileSize = 1 << 20
	maxScanEntries      = 300000
)

// readMinisignSecret returns the file contents when it is a minisign secret
// key, judged by its header bytes and size, never by its name.
func readMinisignSecret(path string) ([]byte, bool) {
	f, err := os.Open(path)
	if err != nil {
		return nil, false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || !st.Mode().IsRegular() || st.Size() < minKeyFileSize || st.Size() > maxKeyFileSize {
		return nil, false
	}
	data, err := io.ReadAll(io.LimitReader(f, maxKeyFileSize+1))
	if err != nil {
		return nil, false
	}
	return data, isMinisignSecretText(data)
}

// isMinisignSecretText accepts the file form (comment line naming a secret
// key) and a bare 158-byte-decoded key line.
func isMinisignSecretText(data []byte) bool {
	line, rest, _ := bytes.Cut(data, []byte("\n"))
	if bytes.HasPrefix(line, []byte("untrusted comment:")) {
		l := bytes.ToLower(line)
		// A .minisig signature made with a secret key says "signature from
		// minisign secret key"; that is not a key.
		if !bytes.Contains(l, []byte("secret key")) || bytes.Contains(l, []byte("signature from")) {
			return false
		}
		second, _, _ := bytes.Cut(rest, []byte("\n"))
		return looksLikeBareKey(second)
	}
	return looksLikeBareKey(data)
}

// looksLikeBareKey matches a lone base64 line of a secret key (starts "RW",
// 212 base64 characters for the 158-byte structure).
func looksLikeBareKey(data []byte) bool {
	s := strings.TrimSpace(string(data))
	if len(s) != 212 || !strings.HasPrefix(s, "RW") || strings.ContainsAny(s, " \n") {
		return false
	}
	b, err := base64.StdEncoding.DecodeString(s)
	return err == nil && len(b) == 158
}

func hasKeystoreExt(p string) bool { return keystoreExts[strings.ToLower(filepath.Ext(p))] }

func isJKS(p string) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	var h [4]byte
	_, err = io.ReadFull(f, h[:])
	return err == nil && h == [4]byte{0xFE, 0xED, 0xFE, 0xED}
}

type discovered struct {
	keys      []fileCand
	keystores []fileCand
}

type fileCand struct {
	Path  string
	Where string
}

func (d *discovered) addKey(path, where string) {
	for _, c := range d.keys {
		if c.Path == path {
			return
		}
	}
	d.keys = append(d.keys, fileCand{path, where})
}

func (d *discovered) addKeystore(path, where string) {
	for _, c := range d.keystores {
		if c.Path == path {
			return
		}
	}
	d.keystores = append(d.keystores, fileCand{path, where})
}

// fastSources gathers files from the standard places, user-added paths and
// the pairing cache.
func (m *Manager) fastSources() *discovered {
	d := &discovered{}
	g := m.opt.Getenv
	stdKeyDirs := []string{filepath.Join(m.opt.Home, ".minisign"), filepath.Join(m.opt.Home, ".config", "minisign")}
	if v := g("MINISIGN_CONFIG_DIR"); v != "" {
		stdKeyDirs = append([]string{m.expand(v)}, stdKeyDirs...)
	}
	for _, dir := range stdKeyDirs {
		m.walk(dir, 2, func(p string) {
			if _, ok := readMinisignSecret(p); ok {
				d.addKey(p, "file "+m.tilde(p))
			}
		})
	}
	m.walk(filepath.Join(m.opt.Home, ".android"), 2, func(p string) {
		if hasKeystoreExt(p) {
			d.addKeystore(p, "file "+m.tilde(p))
		}
	})
	for _, up := range m.loadConfig().Paths {
		st, err := os.Stat(up)
		if err != nil {
			continue
		}
		if !st.IsDir() {
			if _, ok := readMinisignSecret(up); ok {
				d.addKey(up, "added file "+m.tilde(up))
			}
			if hasKeystoreExt(up) || isJKS(up) {
				d.addKeystore(up, "added file "+m.tilde(up))
			}
			continue
		}
		m.walk(up, 4, func(p string) {
			if _, ok := readMinisignSecret(p); ok {
				d.addKey(p, "added folder "+m.tilde(p))
			}
			if hasKeystoreExt(p) {
				d.addKeystore(p, "added folder "+m.tilde(p))
			}
		})
	}
	for _, e := range m.loadCache().Keys {
		if _, ok := readMinisignSecret(e.Path); ok {
			d.addKey(e.Path, "file "+m.tilde(e.Path)+" (remembered)")
		}
	}
	return d
}

// walk visits regular files under root up to depth levels (1 = root only).
func (m *Manager) walk(root string, depth int, visit func(path string)) {
	st, err := os.Stat(root)
	if err != nil || !st.IsDir() {
		return
	}
	base := strings.Count(filepath.Clean(root), string(filepath.Separator))
	_ = filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			if strings.Count(p, string(filepath.Separator))-base >= depth {
				return fs.SkipDir
			}
			return nil
		}
		if d.Type().IsRegular() {
			visit(p)
		}
		return nil
	})
}

// scanHome walks the home folder (bounded by depth, time and entry count) and
// adds every minisign secret key (by header) and keystore (by extension).
func (m *Manager) scanHome(ctx context.Context, d *discovered) {
	if m.opt.NoHomeScan || m.opt.Home == "" {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, m.opt.ScanTimeout)
	defer cancel()
	deadline := time.Now().Add(m.opt.ScanTimeout)
	root := m.opt.Home
	base := strings.Count(root, string(filepath.Separator))
	n := 0
	_ = filepath.WalkDir(root, func(p string, e fs.DirEntry, err error) error {
		if err != nil {
			if e != nil && e.IsDir() {
				return fs.SkipDir
			}
			return nil
		}
		n++
		if n > maxScanEntries || (n%256 == 0 && (ctx.Err() != nil || time.Now().After(deadline))) {
			return fs.SkipAll
		}
		if e.IsDir() {
			if p == root {
				return nil
			}
			name := e.Name()
			if strings.HasPrefix(name, ".") || scanSkip[name] || strings.Count(p, string(filepath.Separator))-base >= m.opt.ScanDepth {
				return fs.SkipDir
			}
			return nil
		}
		if !e.Type().IsRegular() {
			return nil
		}
		if hasKeystoreExt(p) {
			if st, err := e.Info(); err == nil && st.Size() <= maxKeystoreFileSize {
				d.addKeystore(p, "home scan "+m.tilde(p))
			}
			return nil
		}
		if st, err := e.Info(); err == nil && st.Size() >= minKeyFileSize && st.Size() <= maxKeyFileSize {
			if _, ok := readMinisignSecret(p); ok {
				d.addKey(p, "home scan "+m.tilde(p))
			}
		}
		return nil
	})
}

func sortedCands(c []fileCand) []fileCand {
	sort.SliceStable(c, func(i, j int) bool { return c[i].Path < c[j].Path })
	return c
}
