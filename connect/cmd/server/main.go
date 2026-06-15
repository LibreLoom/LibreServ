package main

import (
	"fmt"
	"log/slog"
	"net/http"
	"os"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
)

func main() {
	cfgPath := os.Getenv("CONNECT_CONFIG")
	if cfgPath == "" {
		cfgPath = "configs/connect.yaml"
	}

	if err := config.Load(cfgPath); err != nil {
		if os.IsNotExist(err) {
			slog.Info("config file not found, using env defaults", "path", cfgPath)
		} else {
			slog.Error("failed to load config", "error", err)
			os.Exit(1)
		}
	}

	db, err := database.Open(config.C.Database.Path)
	if err != nil {
		slog.Error("failed to open database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	if err := database.Migrate(db); err != nil {
		slog.Error("failed to migrate database", "error", err)
		os.Exit(1)
	}

	srv := api.NewServer(db)

	addr := config.C.Server.Address
	port := config.C.Server.Port
	if port == 0 {
		port = 8080
	}
	bind := fmt.Sprintf("%s:%d", addr, port)

	slog.Info("connect server starting", "address", bind)
	if err := http.ListenAndServe(bind, srv.Router()); err != nil {
		slog.Error("server failed", "error", err)
		os.Exit(1)
	}
}
