package main

import (
	"log/slog"
	"net"
	"net/http"
	"os"
	"strconv"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/api"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

func main() {
	cfgPath := os.Getenv("LUNACONNECT_CONFIG")
	if cfgPath == "" {
		cfgPath = "configs/luna-connect.yaml"
	}
	if err := config.Load(cfgPath); err != nil && !os.IsNotExist(err) {
		slog.Error("config", "error", err)
		os.Exit(1)
	}
	if config.C.Server.Port == 0 {
		config.C.Server.Port = 8092
	}
	if config.C.Database.Path == "" {
		config.C.Database.Path = "dev/luna-connect.db"
	}
	if config.C.DataDir == "" {
		config.C.DataDir = "dev/data"
	}

	db, err := database.Open(config.C.Database.Path)
	if err != nil {
		slog.Error("db", "error", err)
		os.Exit(1)
	}
	defer db.Close()
	if err := database.Migrate(db); err != nil {
		slog.Error("migrate", "error", err)
		os.Exit(1)
	}
	st, err := store.NewLocal(config.C.DataDir)
	if err != nil {
		slog.Error("store", "error", err)
		os.Exit(1)
	}

	go func() {
		t := time.NewTicker(24 * time.Hour)
		defer t.Stop()
		for range t.C {
			billing.ReportUsage(db)
		}
	}()

	srv := api.NewServer(db, st)
	bind := net.JoinHostPort(config.C.Server.Address, strconv.Itoa(config.C.Server.Port))
	slog.Info("luna connect starting", "addr", bind)
	httpServer := &http.Server{
		Addr:              bind,
		Handler:           srv.Router(),
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
	}
	if err := httpServer.ListenAndServe(); err != nil {
		slog.Error("server", "error", err)
		os.Exit(1)
	}
}
