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
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth/webauthn"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/connect"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobqueue"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobs"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/license"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/logger"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network/bluetooth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/notify"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/oidc"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/podman"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/settings"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage/restic"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/support"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/system"
)

func main() {
	cfgPath := flag.String("config", "./configs/libreserv.yaml", "path to configuration file")
	flag.Parse()

	// Dispatch config subcommand before loading the full server
	args := flag.Args()
	if len(args) > 0 && args[0] == "config" {
		handleConfigCommand(args[1:], *cfgPath)
		return
	}

	if err := config.LoadConfig(*cfgPath); err != nil {
		log.Fatalf("failed to load config: %v", err)
	}
	cfg := config.Get()

	if err := security.ValidateProductionReadiness(); err != nil {
		slog.Error("security validation failed", "error", err)
		fmt.Fprintf(os.Stderr, "\nFor local development, run with: LIBRESERV_INSECURE_DEV=true ./bin/libreserv serve --config ./configs/libreserv.yaml\n")
		os.Exit(1)
	}

	// Check if we need to rollback from a failed update
	serverURL := fmt.Sprintf("http://%s:%d", cfg.Server.Host, cfg.Server.Port)
	if rolledBack, err := system.VerifyAndUpdate(serverURL); err != nil {
		slog.Error("Post-update verification failed", "error", err)
	} else if rolledBack {
		slog.Info("System rolled back to previous version due to health check failure")
		fmt.Fprintf(os.Stderr, "\n⚠️  Update failed - rolled back to previous version\n")
		fmt.Fprintf(os.Stderr, "Check logs for details. Automatic rollback completed.\n\n")
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

	// Clean up stale safety-net backup files from previous interrupted operations.
	if err := db.CleanupStaleBackups(); err != nil {
		slog.Warn("failed to cleanup stale database backups", "error", err)
	}

	// Initialize settings service and load DB-backed settings into memory.
	// On first run (empty table), seed from YAML config values.
	settingsService := settings.NewService(db.SQL())
	settingsRepo := settingsService.Repository()
	isEmpty, err := settingsRepo.IsEmpty()
	if err != nil {
		slog.Warn("failed to check settings table", "error", err)
	}
	if isEmpty {
		if err := settingsRepo.SeedFromConfig(); err != nil {
			slog.Warn("failed to seed settings from config", "error", err)
		}
	}
	if err := settingsRepo.LoadIntoConfig(); err != nil {
		slog.Warn("failed to load settings from database", "error", err)
	}

	lic, err := license.Load(cfg.License.EntitlementFile, cfg.License.PublicKeyFile)
	if err != nil {
		slog.Warn("license load failed", "error", err)
	}

	runtimeClient, err := podman.NewClient(cfg.Runtime)
	if err != nil {
		slog.Error("failed to initialize container runtime", "error", err)
		os.Exit(1)
	}

	runtimeAdapter := podman.NewRuntimeAdapter(runtimeClient)
	monitor := monitoring.NewMonitor(db, runtimeAdapter, cfg.Apps.DataPath)
	monitor.Start()
	defer monitor.Stop()

	// Clean up leaked restic password temp files from previous crashes.
	restic.CleanupLeakedPasswordFiles()

	backupBase := filepath.Join(cfg.Apps.DataPath, "backups")
	backupService := storage.NewBackupService(db, runtimeClient, backupBase, cfg.Apps.DataPath)
	backupService.SetServerSecret(cfg.Auth.JWTSecret)

	if cfg.Auth.CloudEncryptionKey == "" {
		slog.Error("auth.cloud_encryption_key is not set — cloud backup credentials cannot be encrypted. Set LIBRESERV_AUTH_CLOUD_ENCRYPTION_KEY or auth.cloud_encryption_key in config")
		os.Exit(1)
	}
	if cfg.Auth.CloudEncryptionKey == cfg.Auth.CSRFSecret {
		slog.Error("auth.cloud_encryption_key cannot be the same as auth.csrf_secret for security reasons.")
		os.Exit(1)
	}
	backupService.SetEncryptionKey(cfg.Auth.CloudEncryptionKey)

	// Clean up ghost database backup records from previous "Save DB" downloads.
	if err := backupService.CleanupGhostDatabaseBackups(context.Background()); err != nil {
		slog.Warn("failed to cleanup ghost database backups", "error", err)
	}

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
		AuthPort: cfg.Server.Port,
	})
	if caddyManager != nil {
		if err := caddyManager.Initialize(context.Background()); err != nil {
			slog.Warn("caddy initialization failed", "error", err)
		}
	}

	// Initialize ACME manager — single shared instance, also passed to the API
	// server (ServerConfig.ACMEManager) so background jobs and HTTP handlers use
	// the same config and never drift on Auto/External settings.
	acmeManager := network.NewACMEManager(cfg.Network.Caddy.AdminAPI, cfg.Network.Caddy.ConfigPath).
		WithAuto(cfg.Network.Caddy.AutoHTTPS)

	ext := cfg.Network.ACME.External
	extCfg := network.ExternalACMEConfig{
		Enabled:        ext.Enabled,
		UsePodman:      ext.UsePodman,
		ContainerImage: ext.ContainerImage,
		DataPath:       ext.DataPath,
		DNSProvider:    ext.DNSProvider,
		DNSEnv:         ext.DNSEnv,
		Email:          ext.Email,
		Staging:        ext.Staging,
		CADirURL:       ext.CADirURL,
		KeyType:        ext.KeyType,
		CertsPath:      ext.CertsPath,
	}
	// Default cert destination to Caddy's configured cert dir if unset.
	if extCfg.CertsPath == "" && caddyManager != nil {
		extCfg.CertsPath = caddyManager.Config().CertsPath
	}
	// Default email to Caddy email if unset.
	if extCfg.Email == "" && caddyManager != nil {
		extCfg.Email = caddyManager.Config().Email
	}
	acmeManager = acmeManager.WithExternal(extCfg)

	if extCfg.Enabled {
		// Validate external ACME configuration (after Caddy defaults applied).
		if extCfg.Email == "" {
			slog.Warn("external ACME enabled but no email configured")
		}
		if extCfg.DataPath == "" {
			slog.Warn("external ACME enabled but no data_path configured - using default")
		}
		if extCfg.CertsPath == "" {
			slog.Warn("external ACME enabled but no certs_path configured")
		}
		if extCfg.DNSProvider == "" {
			slog.Warn("external ACME enabled but no DNS provider configured")
		}
	}

	// Initialize and start job queue
	jobQueue := jobqueue.NewQueue(jobqueue.QueueConfig{
		DB: db,
	})

	// Register job handlers
	issuanceHandler := network.NewIssuanceHandler(acmeManager, caddyManager)
	renewalHandler := network.NewRenewalHandler(acmeManager, caddyManager)
	validationHandler := network.NewValidationHandler()
	revocationHandler := network.NewRevocationHandler(acmeManager, caddyManager)

	if err := jobQueue.RegisterHandler(issuanceHandler, jobqueue.HandlerConfig{WorkerCount: 3, QueueSize: 200}); err != nil {
		slog.Error("failed to register issuance handler", "error", err)
		os.Exit(1)
	}
	if err := jobQueue.RegisterHandler(renewalHandler, jobqueue.HandlerConfig{WorkerCount: 2, QueueSize: 100}); err != nil {
		slog.Error("failed to register renewal handler", "error", err)
		os.Exit(1)
	}
	if err := jobQueue.RegisterHandler(validationHandler, jobqueue.HandlerConfig{WorkerCount: 2, QueueSize: 50}); err != nil {
		slog.Error("failed to register validation handler", "error", err)
		os.Exit(1)
	}
	if err := jobQueue.RegisterHandler(revocationHandler, jobqueue.HandlerConfig{WorkerCount: 1, QueueSize: 20}); err != nil {
		slog.Error("failed to register revocation handler", "error", err)
		os.Exit(1)
	}

	if err := jobQueue.Start(); err != nil {
		slog.Error("failed to start job queue", "error", err)
		os.Exit(1)
	}
	defer jobQueue.Stop()

	// Initialize and start renewal scheduler
	renewalScheduler := network.NewRenewalScheduler(jobQueue, caddyManager, network.DefaultRenewalSchedulerConfig())
	renewalScheduler.Start()
	defer renewalScheduler.Stop()

	// Ensure apps data directory exists with correct permissions before app manager init
	appsDataDir := cfg.Apps.DataPath
	if err := os.MkdirAll(appsDataDir, 0755); err != nil {
		slog.Warn("failed to create apps data directory, continuing anyway", "path", appsDataDir, "error", err)
	} else if err := os.Chmod(appsDataDir, 0755); err != nil {
		slog.Warn("failed to fix apps data directory permissions", "path", appsDataDir, "error", err)
	}

	appManager, err := apps.NewManager(
		cfg.Apps.CatalogPath,
		cfg.Apps.DataPath,
		runtimeAdapter,
		db,
		monitor,
		backupService,
		caddyManager, // NEW: Pass CaddyManager for route creation
	)
	if err != nil {
		slog.Error("failed to initialize app manager", "error", err)
		os.Exit(1)
	}

	// Wire repo-based app catalog: clone/pull configured git repos and
	// merge their apps into the catalog. The RepoSet runs a background
	// pull loop so the catalog stays current without restarts.
	if len(cfg.Apps.Repos) > 0 {
		interval := 6 * time.Hour
		if d, err := time.ParseDuration(cfg.Apps.RepoPullInterval); err == nil && d > 0 {
			interval = d
		}
		repoBasePath := filepath.Join(appsDataDir, "repos")
		if err := os.MkdirAll(repoBasePath, 0750); err != nil {
			slog.Warn("failed to create repos directory, continuing with local catalog only", "path", repoBasePath, "error", err)
		} else {
			repoSet, err := apps.NewRepoSet(slog.Default().With("component", "repo-set"), cfg.Apps.Repos, repoBasePath, interval)
			if err != nil {
				slog.Warn("failed to initialize repo set, continuing with local catalog only", "error", err)
			} else {
				appManager.SetRepoSet(repoSet)
				repoSet.SetCatalogRefreshCallback(handlers.ClearIconCache)
				if err := repoSet.Start(context.Background()); err != nil {
					slog.Warn("failed to start repo set background pull", "error", err)
				}
				defer repoSet.Stop()
			}
		}
	}

	appManager.Start(context.Background())
	defer appManager.Stop()

	settingsService.OnChange(func(changedKeys []string) {
		go appManager.PropagateServerContext(context.Background(), changedKeys)
	})

	authService := auth.NewService(db, cfg.Auth.JWTSecret, slog.Default())

	setupService := setup.NewService(db)
	setupService.SetupCodePath = setup.DefaultSetupCodePath
	if state, err := setupService.Ensure(context.Background()); err == nil && state.Status != setup.StatusComplete {
		if state.Nonce != "" {
			slog.Info("Setup code. Enter this code in the web setup to continue from another device.", "code", state.Nonce)
		}
	}
	supportService := support.NewService(db, lic)
	auditService := audit.NewService(db)

	emailSender, _ := email.NewSender()
	notifyService := notify.NewService(authService, emailSender)

	// MFA: wire the TOTP at-rest encryption key (fail-closed if unset) + the
	// email-OTP sender (adapted to the api.EmailSender interface). WebAuthn is
	// wired separately once the verifier is constructed (nil-safe until then).
	authService.SetMFATOTPEncryptionKey(cfg.Auth.MFA.TOTPEncryptionKey)
	var mfaEmail api.EmailSender
	if emailSender != nil {
		mfaEmail = mfaOTPSender{emailSender}
	}

	// WebAuthn (passkeys + security keys): construct the verifier from config;
	// nil-safe — if RPID/Origins are unset or construction fails, skip wiring so
	// webauthn methods return ErrMFAVerifierUnavailable (no crash). Non-https dev
	// usually has no origins set, so this stays nil there.
	if wc := cfg.Auth.MFA.WebAuthn; wc.RPID != "" && len(wc.Origins) > 0 {
		timeout := 60 * time.Second
		if d, err := time.ParseDuration(wc.Timeout); err == nil && d > 0 {
			timeout = d
		}
		if v, err := webauthn.New(webauthn.Config{
			RPID:          wc.RPID,
			RPDisplayName: wc.RPDisplayName,
			Origins:       wc.Origins,
			Timeout:       timeout,
		}); err != nil {
			slog.Warn("webauthn verifier disabled", "error", err)
		} else {
			authService.SetWebAuthnVerifier(v)
			slog.Info("webauthn mfa enabled", "rp_id", wc.RPID)
		}
	} else {
		slog.Info("webauthn mfa not configured (auth.webauthn.rp_id/origins unset); passkeys/security keys unavailable")
	}

	sysChecker := system.NewUpdateChecker(cfg.Updates)
	restartCh := make(chan system.RestartSignal, 1)
	sysChecker.SetRestartChannel(restartCh)
	scheduler := jobs.NewScheduler(appManager, sysChecker, notifyService, handlers.Version)
	scheduler.SetBackupService(backupService)
	scheduler.Start()
	defer scheduler.Stop()

	connectClient := connect.NewClientFromEnv()
	connectChecker := connect.NewEntitlementChecker(connectClient)
	connectChecker.Refresh()

	// OIDC Provider: LibreServ acts as an OIDC Identity Provider for apps
	// with access_model = "internal". The issuer URL is derived from the
	// Caddy default domain (or localhost in dev).
	issuerURL := fmt.Sprintf("http://%s:%d", cfg.Server.Host, cfg.Server.Port)
	if d := cfg.Network.Caddy.DefaultDomain; d != "" {
		issuerURL = "https://" + d
	}
	oidcStorage := oidc.NewStorageWithAuthService(db, authService, cfg.Auth.CloudEncryptionKey, slog.Default())
	oidcHandler, err := oidc.NewProvider(oidcStorage, issuerURL, slog.Default())
	if err != nil {
		slog.Warn("failed to initialize OIDC provider", "error", err)
	}
	oidcAdminHandler := handlers.NewOIDCHandler(db, appManager, authService, issuerURL, slog.Default())
	// Wire OIDC auto-provisioning for internal-access apps during install.
	appManager.SetOIDCProvisioner(func(instanceID, appName, redirectPath string) (string, string, string, error) {
		redirectURIs := []string{fmt.Sprintf("https://%s%s", appName, redirectPath)}
		cid, secret, err := handlers.ProvisionOIDCClient(db, instanceID, appName, redirectURIs, issuerURL, slog.Default())
		return cid, secret, issuerURL, err
	})

	// Wire route registrar: when apps get domain routes, register the public
	// hostname with Connect's tunnel (DNS CNAME + ingress + auto cert).
	// Only active when Connect is connected with a tunnel.
	appManager.SetRouteRegistrar(func(hostname string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := connectClient.RegisterRoute(ctx, hostname); err != nil {
			return fmt.Errorf("could not register %s with Connect: %w", hostname, err)
		}
		return nil
	})
	appManager.SetRouteUnregistrar(func(hostname string) error {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		if err := connectClient.UnregisterRoute(ctx, hostname); err != nil {
			return fmt.Errorf("could not unregister %s with Connect: %w", hostname, err)
		}
		return nil
	})

	// Start local SMTP relay — apps send to localhost, the relay forwards
	// to the configured upstream (Connect SMTP or user-configured SMTP).
	smtpRelay := email.NewRelay()
	if err := smtpRelay.Start(); err != nil {
		slog.Warn("failed to start SMTP relay, apps will not be able to send email", "error", err)
	} else {
		defer smtpRelay.Stop()
	}
	server := api.NewServer(api.ServerConfig{
		Host:             cfg.Server.Host,
		Port:             cfg.Server.Port,
		DevMode:          cfg.Server.Mode == "development" || os.Getenv("LIBRESERV_INSECURE_DEV") == "true",
		DB:               db,
		AppManager:       appManager,
		AuthService:      authService,
		Monitor:          monitor,
		BackupService:    backupService,
		RuntimeClient:    runtimeClient,
		CaddyManager:     caddyManager,
		ACMEManager:      acmeManager,
		SetupService:     setupService,
		SupportService:   supportService,
		LicenseService:   lic,
		SysChecker:       sysChecker,
		AuditService:     auditService,
		SettingsService:  settingsService,
		ConnectClient:    connectClient,
		ConnectChecker:   connectChecker,
		EmailSender:      mfaEmail,
		OIDCHandler:      oidcHandler,
		OIDCAdminHandler: oidcAdminHandler,
	}).WithJobQueue(jobQueue)

	bluetooth.SetRouter(server.Router())
	bleSvc := bluetooth.NewService("", slog.Default())
	if cfg.Network.Bluetooth.Enabled {
		setupCode, err := setupService.SetupToken(context.Background())
		if err != nil {
			slog.Warn("failed to retrieve setup code, skipping bluetooth", "error", err)
		} else {
			bleSvc = bluetooth.NewService(setupCode, slog.Default())
			if err := bleSvc.Start(); err != nil {
				slog.Warn("failed to start bluetooth service", "error", err)
			}
		}
	}

	errCh := make(chan error, 1)
	go func() {
		if err := server.Start(); err != nil {
			errCh <- err
		}
	}()

	appManager.StartInstalledApps(context.Background())
	appManager.RefreshMetrics(context.Background())

	var mdnsService *network.MDNSService
	if cfg.Network.MDNS.Enabled {
		mdnsPort := cfg.Server.Port
		if cfg.Network.Caddy.Mode == "enabled" {
			mdnsPort = 80
		}
		mdnsService = network.NewMDNSService(cfg.Server.Host, mdnsPort)
		if err := mdnsService.Start(); err != nil {
			slog.Warn("failed to start mDNS advertisement", "error", err)
		}
	}

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
	case <-restartCh:
		slog.Info("restart signal received from update system")
		// Perform graceful shutdown before restart
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = server.Shutdown(ctx)
		_ = runtimeClient.Close()
		if mdnsService != nil {
			mdnsService.Stop()
		}
		bleSvc.Stop()

		// Re-execute the current binary
		execPath, _ := os.Executable()
		slog.Info("Restarting application", "path", execPath)
		if err := syscall.Exec(execPath, os.Args, os.Environ()); err != nil {
			slog.Error("Failed to restart", "error", err)
			os.Exit(1)
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
	if mdnsService != nil {
		mdnsService.Stop()
	}
	bleSvc.Stop()
	_ = runtimeClient.Close()
}

// ensureSecrets autogenerates JWT/CSRF/cloud-encryption secrets if missing and persists them.
func ensureSecrets(cfgPath string) error {
	cfg := config.Get()
	missingJWT := cfg.Auth.JWTSecret == ""
	missingCSRF := cfg.Auth.CSRFSecret == ""
	missingCloud := cfg.Auth.CloudEncryptionKey == ""
	missingTOTPKey := cfg.Auth.MFA.TOTPEncryptionKey == ""
	if !missingJWT && !missingCSRF && !missingCloud && !missingTOTPKey {
		return nil
	}

	// Policy:
	// - Secrets may come from env or config (already loaded).
	// - If secrets are missing at startup, we will generate them and persist to config.
	// - If the config path is not writable, fail fast with a clear remediation.
	if cfgPath == "" {
		return fmt.Errorf(
			"missing required secrets and no config path was provided to persist generated secrets; set env vars LIBRESERV_AUTH_JWT_SECRET, LIBRESERV_AUTH_CSRF_SECRET, and LIBRESERV_AUTH_CLOUD_ENCRYPTION_KEY (recommended for read-only configs) or run with a writable --config path",
		)
	}
	writable, err := config.IsWritableFilePath(cfgPath)
	if err != nil {
		return fmt.Errorf("checking config writability for %q: %w", cfgPath, err)
	}
	if !writable {
		return fmt.Errorf(
			"missing required secrets but config file is not writable (%q). Provide secrets via env (LIBRESERV_AUTH_JWT_SECRET, LIBRESERV_AUTH_CSRF_SECRET, LIBRESERV_AUTH_CLOUD_ENCRYPTION_KEY) or make the config path writable",
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
	if missingCloud {
		secret, err := auth.GenerateSecureKey(32)
		if err != nil {
			return fmt.Errorf("generate cloud encryption key: %w", err)
		}
		cfg.Auth.CloudEncryptionKey = secret
		updated = true
	}
	if missingTOTPKey {
		// AES-GCM key for TOTP-secret-at-rest. Must be stable across restarts or
		// enrolled TOTP methods can't be decrypted (softlock), so persist it.
		secret, err := auth.GenerateSecureKey(32)
		if err != nil {
			return fmt.Errorf("generate totp encryption key: %w", err)
		}
		cfg.Auth.MFA.TOTPEncryptionKey = secret
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
