package logger

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

var logFile *os.File

// multiHandler fans out a single slog.Record to multiple handlers.
// This is used to log to both stdout and a file simultaneously.
type multiHandler struct {
	hs []slog.Handler
}

func (m multiHandler) Enabled(ctx context.Context, level slog.Level) bool {
	for _, h := range m.hs {
		if h.Enabled(ctx, level) {
			return true
		}
	}
	return false
}

func (m multiHandler) Handle(ctx context.Context, r slog.Record) error {
	var firstErr error
	for _, h := range m.hs {
		rr := r.Clone()
		if err := h.Handle(ctx, rr); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
}

func (m multiHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	next := make([]slog.Handler, 0, len(m.hs))
	for _, h := range m.hs {
		next = append(next, h.WithAttrs(attrs))
	}
	return multiHandler{hs: next}
}

func (m multiHandler) WithGroup(name string) slog.Handler {
	next := make([]slog.Handler, 0, len(m.hs))
	for _, h := range m.hs {
		next = append(next, h.WithGroup(name))
	}
	return multiHandler{hs: next}
}

// Init configures the global logger based on config.
func Init(cfg config.LoggingConfig) {
	var level slog.Level
	switch cfg.Level {
	case "debug":
		level = slog.LevelDebug
	case "info":
		level = slog.LevelInfo
	case "warn":
		level = slog.LevelWarn
	case "error":
		level = slog.LevelError
	default:
		level = slog.LevelInfo
	}

	stdoutOpts := &slog.HandlerOptions{
		Level: level,
	}
	fileOpts := &slog.HandlerOptions{
		Level: level,
	}

	// Console handler: text in debug, JSON otherwise.
	var stdoutHandler slog.Handler
	if cfg.Level == "debug" {
		stdoutHandler = slog.NewTextHandler(os.Stdout, stdoutOpts)
	} else {
		stdoutHandler = slog.NewJSONHandler(os.Stdout, stdoutOpts)
	}

	// Optional file handler: always JSON for easy ingestion.
	var handlers []slog.Handler
	handlers = append(handlers, stdoutHandler)

	if cfg.Path != "" {
		path := strings.TrimSpace(cfg.Path)
		filePath := path
		// If cfg.Path looks like a directory (no extension), place libreserv.log inside it.
		if filepath.Ext(path) == "" {
			filePath = filepath.Join(path, "libreserv.log")
		}

		if err := os.MkdirAll(filepath.Dir(filePath), 0o755); err != nil {
			fmt.Fprintln(os.Stderr, "logger: failed to create log directory:", err)
		} else {
			f, err := os.OpenFile(filePath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o600)
			if err != nil {
				fmt.Fprintln(os.Stderr, "logger: failed to open log file:", err)
			} else {
				logFile = f
				fileHandler := slog.NewJSONHandler(io.MultiWriter(f), fileOpts)
				handlers = append(handlers, fileHandler)
			}
		}
	}

	var handler slog.Handler
	if len(handlers) == 1 {
		handler = handlers[0]
	} else {
		handler = multiHandler{hs: handlers}
	}

	logger := slog.New(handler)
	slog.SetDefault(logger)

	if logFile != nil {
		slog.Info("File logging enabled", "path", logFile.Name())
	}
}

// Close closes the optional log file, if opened.
func Close() error {
	if logFile == nil {
		return nil
	}
	err := logFile.Close()
	logFile = nil
	return err
}
