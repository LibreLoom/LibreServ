package storage

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestBackupSlogPrintfLevels(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	cases := []struct {
		msg   string
		level string
	}{
		{"BackupService: restic engine initialized (binary found)", "level=INFO"},
		{"Warning: failed to checksum database backup", "level=WARN"},
		{"Failed to delete old backup x", "level=WARN"},
		{"failed to close rows: boom", "level=WARN"},
		{"DeleteBackup: restic forget failed for snapshot s: err", "level=WARN"},
		{"ERROR: failed to restart app after backup", "level=ERROR"},
	}

	for _, tc := range cases {
		buf.Reset()
		log.Printf("%s", tc.msg)
		out := buf.String()
		if !strings.Contains(out, tc.level) {
			t.Fatalf("msg %q: want %s in %q", tc.msg, tc.level, out)
		}
		if !strings.Contains(out, "component=backup") {
			t.Fatalf("msg %q: missing component=backup in %q", tc.msg, out)
		}
		if !strings.Contains(out, tc.msg) {
			t.Fatalf("msg %q: missing message text in %q", tc.msg, out)
		}
	}
}
