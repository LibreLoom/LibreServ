package secrets

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"sort"
)

// Config is the user's non-secret settings, kept in
// ~/.config/libreserv-release/secrets.json.
type Config struct {
	// Paths are extra files or folders to search for keys and keystores.
	Paths []string `json:"paths,omitempty"`
	// Choices resolves conflicts: secret ID -> candidate ref the user picked.
	Choices map[ID]string `json:"choices,omitempty"`
	// AndroidCertSHA256 pins the release certificate (hex, no colons).
	AndroidCertSHA256 string `json:"android_cert_sha256,omitempty"`
	// AndroidAlias overrides the keystore alias (default "luna").
	AndroidAlias string `json:"android_alias,omitempty"`
	// Proton configures the optional Proton Pass source.
	Proton ProtonConfig `json:"proton"`
	// Store is the user's explicit choice of where remembered values live:
	// "system" or "vault" (see StoreManager). Empty: the default.
	Store string `json:"store,omitempty"`
}

func (m *Manager) configPath() string { return filepath.Join(m.opt.ConfigDir, "secrets.json") }

func (m *Manager) loadConfig() Config { return loadConfigIn(m.opt.ConfigDir) }

func (m *Manager) saveConfig(c Config) error { return saveConfigIn(m.opt.ConfigDir, c) }

func loadConfigIn(dir string) Config {
	var c Config
	b, err := os.ReadFile(filepath.Join(dir, "secrets.json"))
	if err == nil {
		_ = json.Unmarshal(b, &c)
	}
	return c
}

func saveConfigIn(dir string, c Config) error {
	sort.Strings(c.Paths)
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return writeFileAtomic(filepath.Join(dir, "secrets.json"), append(b, '\n'), 0o600)
}

// DefaultConfigDir is ~/.config/libreserv-release.
func DefaultConfigDir() string {
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".config", "libreserv-release")
}

// CacheEntry is a non-secret fact about a key file we already worked out.
type CacheEntry struct {
	Path     string `json:"path"`
	SHA256   string `json:"sha256"`
	KeyID    string `json:"key_id"`
	Password string `json:"password_source,omitempty"` // where the working password came from
}

type cacheFile struct {
	Keys []CacheEntry `json:"keys"`
}

func (m *Manager) cachePath() string { return filepath.Join(m.opt.CacheDir, "secrets.json") }

func (m *Manager) loadCache() cacheFile {
	var c cacheFile
	b, err := os.ReadFile(m.cachePath())
	if err == nil {
		_ = json.Unmarshal(b, &c)
	}
	return c
}

func (m *Manager) saveCache(c cacheFile) {
	sort.Slice(c.Keys, func(i, j int) bool { return c.Keys[i].Path < c.Keys[j].Path })
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return
	}
	_ = writeFileAtomic(m.cachePath(), append(b, '\n'), 0o600)
}

func (m *Manager) cacheLookup(c cacheFile, path, hash string) (CacheEntry, bool) {
	for _, e := range c.Keys {
		if e.Path == path && e.SHA256 == hash {
			return e, true
		}
	}
	return CacheEntry{}, false
}

func (m *Manager) cacheStore(e CacheEntry) {
	c := m.loadCache()
	out := c.Keys[:0]
	for _, x := range c.Keys {
		if x.Path != e.Path {
			out = append(out, x)
		}
	}
	c.Keys = append(out, e)
	m.saveCache(c)
}

func (m *Manager) cacheClear() {
	_ = os.Remove(m.cachePath())
}

func writeFileAtomic(path string, data []byte, perm os.FileMode) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".tmp-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmp.Name(), path)
}

var errNotExist = errors.New("does not exist")
