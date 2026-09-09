package network

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestCaddySlogPrintfLevels(t *testing.T) {
	var buf bytes.Buffer
	prev := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelDebug})))
	t.Cleanup(func() { slog.SetDefault(prev) })

	cases := []struct {
		msg   string
		level string
	}{
		{"Route added: example.com -> 127.0.0.1:8080", "level=INFO"},
		{"Warning: failed to delete route from database: boom", "level=WARN"},
		{"Route added x but Caddy reload failed (kept route): err", "level=WARN"},
		{"Caddy admin reload failed after retries; attempting CLI reload: err", "level=WARN"},
		{"ERROR: caddy config invalid", "level=ERROR"},
	}

	for _, tc := range cases {
		buf.Reset()
		log.Printf("%s", tc.msg)
		out := buf.String()
		if !strings.Contains(out, tc.level) {
			t.Fatalf("msg %q: want %s in %q", tc.msg, tc.level, out)
		}
		if !strings.Contains(out, "component=caddy") {
			t.Fatalf("msg %q: missing component=caddy in %q", tc.msg, out)
		}
		if !strings.Contains(out, tc.msg) {
			t.Fatalf("msg %q: missing message text in %q", tc.msg, out)
		}
	}
}
