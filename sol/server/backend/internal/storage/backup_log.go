package storage

import (
	"fmt"
	"log/slog"
	"strings"
)

// log routes legacy printf-style backup logs through slog so call sites in
// backup.go can keep using log.Printf without a full-file rewrite.
var log = backupSlog{}

type backupSlog struct{}

func (backupSlog) Printf(format string, v ...any) {
	msg := fmt.Sprintf(format, v...)
	attrs := []any{"component", "backup"}
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
