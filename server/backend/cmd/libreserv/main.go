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
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/audit"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobs"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/license"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/logger"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/notify"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/support"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/system"
)

func main() {
	cfgPath := flag.String("config", "./configs/libreserv.yaml", "path to configuration file")
	flag.Parse()

	if err := config.LoadConfig(*cfgPath); err != nil {
		log.Fatalf("failed to load config: %v", err)
	}
	cfg := config.Get()

	if err := security.ValidateProductionReadiness(); err != nil {
		slog.Error("security validation failed", "error", err)
		fmt.Fprintf(os.Stderr, "\nFor local development, run with: LIBRESERV_INSECURE_DEV=true ./bin/libreserv serve --config ./configs/libreserv.yaml\n")
		os.Exit(1)
	}

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
		Mode:          cfg.Network.Caddy.Mode,
		AdminAPI:      cfg.Network.Caddy.AdminAPI,
		ConfigPath:    cfg.Network.Caddy.ConfigPath,
		CertsPath:     cfg.Network.Caddy.CertsPath,
		DefaultDomain: cfg.Network.Caddy.DefaultDomain,
		Email:         cfg.Network.Caddy.Email,
		AutoHTTPS:     cfg.Network.Caddy.AutoHTTPS,
		Reload: network.CaddyReloadConfig{
			Retries:        cfg.Network.Caddy.Reload.Retries,
			BackoffMin:     cfg.Network.Caddy.Reload.BackoffMin,
			BackoffMax:     cfg.Network.Caddy.Reload.BackoffMax,
			JitterFraction: cfg.Network.Caddy.Reload.JitterFraction,
			AttemptTimeout: cfg.Network.Caddy.Reload.AttemptTimeout,
		},
		Logging: network.CaddyLoggingConfig{
			Output: cfg.Network.Caddy.Logging.Output,
			File:   cfg.Network.Caddy.Logging.File,
			Format: cfg.Network.Caddy.Logging.Format,
			Level:  cfg.Network.Caddy.Logging.Level,
		},
	})
	if caddyManager != nil {
		if err := caddyManager.Initialize(context.Background()); err != nil {
			slog.Warn("caddy initialization failed", "error", err)
		}
	}

	runtimeClient := docker.NewRuntimeAdapter(dockerClient)
	appManager, err := apps.NewManager(cfg.Apps.CatalogPath, cfg.Apps.DataPath, runtimeClient, db, monitor, backupService)
	if err != nil {
		slog.Error("failed to initialize app manager", "error", err)
		os.Exit(1)
	}

	authService := auth.NewService(db, cfg.Auth.JWTSecret)

	setupService := setup.NewService(db)
	supportService := support.NewService(db, lic)
	auditService := audit.NewService(db)

	emailSender, _ := email.NewSender()
	notifyService := notify.NewService(authService, emailSender)

	sysChecker := system.NewUpdateChecker("libreloom", "libreserv")
	scheduler := jobs.NewScheduler(appManager, sysChecker, notifyService, handlers.Version)
	scheduler.Start()
	defer scheduler.Stop()

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
		sysChecker,
		auditService,
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
	missingJWT := cfg.Auth.JWTSecret == ""
	missingCSRF := cfg.Auth.CSRFSecret == ""
	if !missingJWT && !missingCSRF {
		return nil
	}

	// Policy:
	// - Secrets may come from env or config (already loaded).
	// - If secrets are missing at startup, we will generate them and persist to config.
	// - If the config path is not writable, fail fast with a clear remediation.
	if cfgPath == "" {
		return fmt.Errorf(
			"missing required secrets (auth.jwt_secret and/or auth.csrf_secret) and no config path was provided to persist generated secrets; set env vars LIBRESERV_AUTH_JWT_SECRET and LIBRESERV_AUTH_CSRF_SECRET (recommended for read-only configs) or run with a writable --config path",
		)
	}
	writable, err := config.IsWritableFilePath(cfgPath)
	if err != nil {
		return fmt.Errorf("checking config writability for %q: %w", cfgPath, err)
	}
	if !writable {
		return fmt.Errorf(
			"missing required secrets (auth.jwt_secret and/or auth.csrf_secret) but config file is not writable (%q). Provide secrets via env (LIBRESERV_AUTH_JWT_SECRET and LIBRESERV_AUTH_CSRF_SECRET) or make the config path writable",
			cfgPath,
		)
	}

	updated := false
	if missingJWT {
		secret, err := auth.GenerateSecureKey(32)
		if err != nil {
			return fmt.Errorf("generate jwt secret: %w", err)
		}
		cfg.Auth.JWTSecret = secret
		updated = true
	}
	if missingCSRF {
		secret, err := auth.GenerateSecureKey(32)
		if err != nil {
			return fmt.Errorf("generate csrf secret: %w", err)
		}
		cfg.Auth.CSRFSecret = secret
		updated = true
	}

	if !updated {
		return nil
	}
	if err := config.SaveConfig(cfgPath); err != nil {
		return fmt.Errorf("persisting generated secrets: %w", err)
	}
	slog.Info("generated missing secrets and updated config")
	return nil
}
