package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSaveConfig_CreatesParentDirsAndWritesFile(t *testing.T) {
	t.Parallel()

	tmp := t.TempDir()
	target := filepath.Join(tmp, "nested", "configs", "libreserv.yaml")

	origCfg := globalConfig
	origPath := configFilePath
	t.Cleanup(func() {
		globalConfig = origCfg
		configFilePath = origPath
	})

	globalConfig = &Config{
		Server: ServerConfig{Host: "127.0.0.1", Port: 8080, Mode: "development"},
		Database: DatabaseConfig{
			Path: "./dev/data/libreserv.db",
		},
	}
	configFilePath = target

	if err := SaveConfig(""); err != nil {
		t.Fatalf("SaveConfig: %v", err)
	}
	if _, err := os.Stat(target); err != nil {
		t.Fatalf("expected config file to exist: %v", err)
	}
	b, err := os.ReadFile(target)
	if err != nil {
		t.Fatalf("read config file: %v", err)
	}
	if len(b) == 0 {
		t.Fatalf("expected config file to have content")
	}
}

func TestIsWritableFilePath_ExistingReadOnlyFile(t *testing.T) {
	t.Parallel()

	tmp := t.TempDir()
	p := filepath.Join(tmp, "libreserv.yaml")
	if err := os.WriteFile(p, []byte("server:\n  host: 127.0.0.1\n"), 0o600); err != nil {
		t.Fatalf("write temp file: %v", err)
	}
	if err := os.Chmod(p, 0o400); err != nil {
		t.Fatalf("chmod read-only: %v", err)
	}

	ok, err := IsWritableFilePath(p)
	if err != nil {
		t.Fatalf("IsWritableFilePath: %v", err)
	}
	if ok {
		t.Fatalf("expected path to be non-writable")
	}
}

func TestIsWritableFilePath_NewFileInWritableDir(t *testing.T) {
	t.Parallel()

	tmp := t.TempDir()
	p := filepath.Join(tmp, "new", "libreserv.yaml")
	ok, err := IsWritableFilePath(p)
	if err != nil {
		t.Fatalf("IsWritableFilePath: %v", err)
	}
	if !ok {
		t.Fatalf("expected path to be writable")
	}
}


