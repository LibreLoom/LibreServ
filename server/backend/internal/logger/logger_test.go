package logger

import (
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

func TestInitCreatesLogFileAndWrites(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "custom.log")

	Init(config.LoggingConfig{Level: "info", Path: path})
	t.Cleanup(func() { _ = Close() })

	slog.Info("hello world", "k", "v")

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("expected log file to be created: %v", err)
	}
	if !strings.Contains(string(data), "hello world") {
		t.Fatalf("log file missing message; contents: %q", string(data))
	}
}
