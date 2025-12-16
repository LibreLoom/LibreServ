package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/license"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/logger"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/support"
)

func main() {
	cfgPath := flag.String("config", "./configs/libreserv.yaml", "path to configuration file")
	flag.Parse()

	if err := config.LoadConfig(*cfgPath); err != nil {
		log.Fatalf("failed to load config: %v", err)
	}
	cfg := config.Get()

	logger.Init(cfg.Logging)
	defer logger.Close()

	if err := ensureSecrets(*cfgPath); err != nil {
		slog.Error("failed to initialize secrets", "error", err)
		os.Exit(1)
	}

	db, err := database.Open(cfg.Database.Path)
	if err != nil {
		slog.Error("failed to open database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	if err := db.Migrate(); err != nil {
		slog.Error("database migration failed", "error", err)
		os.Exit(1)
	}

	lic, err := license.Load(cfg.License.EntitlementFile, cfg.License.PublicKeyFile)
	if err != nil {
		slog.Warn("license load failed", "error", err)
	}

	dockerClient, err := docker.NewClient(cfg.Docker)
	if err != nil {
		slog.Error("failed to initialize docker client", "error", err)
		os.Exit(1)
	}

	monitor := monitoring.NewMonitor(db, dockerClient.GetRawClient())
	monitor.Start()
	defer monitor.Stop()

	backupBase := filepath.Join(cfg.Apps.DataPath, "backups")
	backupService := storage.NewBackupService(db, dockerClient, backupBase, cfg.Apps.DataPath)

	caddyManager := network.NewCaddyManager(db, network.CaddyConfig{
		AdminAPI:      cfg.Network.Caddy.AdminAPI,
		ConfigPath:    cfg.Network.Caddy.ConfigPath,
		DefaultDomain: cfg.Network.Caddy.DefaultDomain,
		Email:         cfg.Network.Caddy.Email,
		AutoHTTPS:     cfg.Network.Caddy.AutoHTTPS,
	})
	if caddyManager != nil {
		if err := caddyManager.Initialize(context.Background()); err != nil {
			slog.Warn("caddy initialization failed", "error", err)
		}
	}

	appManager, err := apps.NewManager(cfg.Apps.CatalogPath, cfg.Apps.DataPath, dockerClient, db, monitor)
	if err != nil {
		slog.Error("failed to initialize app manager", "error", err)
		os.Exit(1)
	}

	authService := auth.NewService(db, cfg.Auth.JWTSecret)
	setupService := setup.NewService(db)
	supportService := support.NewService(db, lic)

	server := api.NewServer(
		cfg.Server.Host,
		cfg.Server.Port,
		db,
		appManager,
		authService,
		monitor,
		backupService,
		dockerClient,
		caddyManager,
		setupService,
		supportService,
		lic,
		cfg.Server.Mode == "development",
	)

	errCh := make(chan error, 1)
	go func() {
		if err := server.Start(); err != nil {
			errCh <- err
		}
	}()

	// Graceful shutdown on SIGINT/SIGTERM
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)

	select {
	case sig := <-sigCh:
		slog.Info("shutdown signal received", "signal", sig.String())
	case err := <-errCh:
		if err != nil {
			slog.Error("server error", "error", err)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	_ = dockerClient.Close()
}

// ensureSecrets autogenerates JWT/CSRF secrets if missing and persists them.
func ensureSecrets(cfgPath string) error {
	cfg := config.Get()
	updated := false

	if cfg.Auth.JWTSecret == "" {
		if secret, err := auth.GenerateSecureKey(32); err == nil {
			cfg.Auth.JWTSecret = secret
			updated = true
		}
	}
	if cfg.Auth.CSRFSecret == "" {
		if secret, err := auth.GenerateSecureKey(32); err == nil {
			cfg.Auth.CSRFSecret = secret
			updated = true
		}
	}

	if !updated {
		return nil
	}
	if cfgPath == "" {
		return fmt.Errorf("config path is empty; cannot persist generated secrets")
	}
	if err := config.SaveConfig(cfgPath); err != nil {
		return fmt.Errorf("persisting generated secrets: %w", err)
	}
	slog.Info("generated missing secrets and updated config")
	return nil
}
