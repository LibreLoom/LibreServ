package logger

import (
	"log/slog"
	"os"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

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

	opts := &slog.HandlerOptions{
		Level: level,
	}

	var handler slog.Handler
	if cfg.Level == "debug" {
		handler = slog.NewTextHandler(os.Stdout, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}
	
	logger := slog.New(handler)
	slog.SetDefault(logger)

	if cfg.Path != "" {
		slog.Warn("File logging not fully implemented yet, logging to stdout", "path", cfg.Path)
	}
}
