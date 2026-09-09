package network

import (
	"io"
	"log"
	"log/slog"
	"strings"
)

// caddySlogWriter routes the process default log.Logger (used by caddy.go
// log.Printf call sites) through slog without rewriting the large caddy.go.
type caddySlogWriter struct{}

func (caddySlogWriter) Write(p []byte) (int, error) {
	msg := strings.TrimSuffix(string(p), "\n")
	if msg == "" {
		return len(p), nil
	}
	attrs := []any{"component", "caddy"}
	switch {
	case strings.HasPrefix(msg, "ERROR:"):
		slog.Error(msg, attrs...)
	case strings.HasPrefix(msg, "Warning:"),
		strings.HasPrefix(msg, "Failed "),
		strings.HasPrefix(msg, "failed "),
		strings.Contains(msg, " failed"):
		slog.Warn(msg, attrs...)
	default:
		slog.Info(msg, attrs...)
	}
	return len(p), nil
}

func init() {
	// Only caddy.go still uses the default stdlib logger in this binary.
	log.SetFlags(0)
	log.SetPrefix("")
	log.SetOutput(caddySlogWriter{})
}

var _ io.Writer = caddySlogWriter{}
