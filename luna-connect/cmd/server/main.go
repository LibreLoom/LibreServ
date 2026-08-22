package main

import (
	"context"
	"flag"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"syscall"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/api"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

var (
	version   = "dev"
	gitCommit = "unknown"
	buildTime = "unknown"
)

func main() {
	healthFlag := flag.Bool("health", false, "run health check against this process port and exit")
	flag.Parse()

	if *healthFlag {
		port := 8101
		if p := os.Getenv("LUNACONNECT_SERVER_PORT"); p != "" {
			fmt.Sscanf(p, "%d", &port)
		}
		client := &http.Client{Timeout: 3 * time.Second}
		resp, err := client.Get("http://" + net.JoinHostPort("127.0.0.1", strconv.Itoa(port)) + "/healthz")
		if err != nil {
			os.Exit(1)
		}
		resp.Body.Close()
		if resp.StatusCode != 200 {
			os.Exit(1)
		}
		os.Exit(0)
	}

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
	httpServer := &http.Server{
		Addr:              bind,
		Handler:           srv.Router(),
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
	}

	errCh := make(chan error, 1)
	go func() {
		slog.Info("luna connect starting", "addr", bind, "version", version, "commit", gitCommit, "built", buildTime)
		errCh <- httpServer.ListenAndServe()
	}()

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	select {
	case err := <-errCh:
		if err != nil && err != http.ErrServerClosed {
			slog.Error("server", "error", err)
			os.Exit(1)
		}
	case <-sig:
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = httpServer.Shutdown(ctx)
	}
}
