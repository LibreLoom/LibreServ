package network

import (
	"fmt"
	"log/slog"
	"strings"
)

// log routes legacy printf-style Caddy logs through slog so call sites in
// caddy.go can keep using log.Printf without a full-file rewrite.
var log = caddySlog{}

type caddySlog struct{}

func (caddySlog) Printf(format string, v ...any) {
	msg := fmt.Sprintf(format, v...)
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
}
