package api

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

// setupRoutes configures all API routes
func (s *Server) setupRoutes() {
	// Apply rate limiting middleware globally to all routes
	s.router.Use(middleware.RateLimitDefault())

	// Initialize all route handlers with required dependencies
	healthHandler := handlers.NewHealthHandler(s.db)
	catalogHandler := handlers.NewCatalogHandler(s.appManager)
	appsHandler := handlers.NewAppsHandler(s.appManager)
	appsHandler.SetAuditLogger(s)
	authHandler := handlers.NewAuthHandler(s.authService, s.securityService)
	securityHandler := handlers.NewSecurityHandler(s.securityService)
	setupHandler := handlers.NewSetupHandler(s.authService, s.setupService, s.dockerClient, s.licenseService)
	monitoringHandler := handlers.NewMonitoringHandlers(s.monitor, s.db, s.dockerClient)
	backupHandler := handlers.NewBackupHandlers(s.backupService)
	usersHandler := handlers.NewUsersHandler(s.authService)
	settingsHandler := handlers.NewSettingsHandler()
	csrfSecret := config.Get().Auth.CSRFSecret
	csrfHandler := handlers.NewCSRFHandler(csrfSecret)
	networkProbeHandler := handlers.NewNetworkProbeHandler()

	// Get Caddy admin API endpoint and config path if available
	adminAPI := ""
	configPath := ""
	if s.caddyManager != nil {
		adminAPI = s.caddyManager.AdminEndpoint()
		configPath = s.caddyManager.ConfigPath()
	}

	// Configure external ACME settings for certificate management
	ext := config.Get().Network.ACME.External
	extCfg := network.ExternalACMEConfig{
		Enabled:     ext.Enabled,
		UseDocker:   ext.UseDocker,
		DockerImage: ext.DockerImage,
		DataPath:    ext.DataPath,
		DNSProvider: ext.DNSProvider,
		DNSEnv:      ext.DNSEnv,
		Email:       ext.Email,
		Staging:     ext.Staging,
		CADirURL:    ext.CADirURL,
		KeyType:     ext.KeyType,
		CertsPath:   ext.CertsPath,
	}
	// Default cert destination to Caddy's configured cert dir if unset.
	if extCfg.CertsPath == "" && s.caddyManager != nil {
		extCfg.CertsPath = s.caddyManager.Config().CertsPath
	}
	// Default email to Caddy email if unset.
	if extCfg.Email == "" && s.caddyManager != nil {
		extCfg.Email = s.caddyManager.Config().Email
	}

	// Initialize ACME manager for automated certificate management
	acmeManager := network.NewACMEManager(adminAPI, configPath).WithAuto(true).WithExternal(extCfg)

	// Initialize Caddy metrics collector
	caddyMetrics := monitoring.NewCaddyMetrics()

	// Wire metrics into Caddy manager if available
	if s.caddyManager != nil {
		s.caddyManager.WithMetrics(caddyMetrics)
	}
	acmeManager.WithMetrics(caddyMetrics)

	acmeHandler := handlers.NewACMEHandler(s.db, acmeManager, s.caddyManager, s.appManager)
	// Wire in job queue if available
	if s.jobQueue != nil {
		acmeHandler = acmeHandler.WithJobQueue(s.jobQueue)
	}
	acmeCleanup := handlers.NewACMECleanupHandler(s.caddyManager)

	// Initialize network handler if Caddy is available
	var networkHandler *handlers.NetworkHandlers
	if s.caddyManager != nil {
		networkHandler = handlers.NewNetworkHandlers(s.caddyManager, s.appManager).WithACME(acmeHandler)
	}

	// Initialize support and system handlers
	supportHandler := handlers.NewSupportHandler(s.supportService, s.licenseService)
	supportDiagHandler := handlers.NewSupportDiagnosticsHandler(s.authService, s.dockerClient)
	supportSessionValidator := handlers.NewSupportSessionValidationHandler(s.supportService)
	supportFileHandler := handlers.NewSupportFileHandler(s.supportService)
	supportCommandHandler := handlers.NewSupportCommandHandler(s.supportService)
	notifyHandler := handlers.NewNotifyHandler()
	licenseHandler := handlers.NewLicenseHandler(s.licenseService)
	systemHandler := handlers.NewSystemHandler(s.sysChecker)
	systemHandler.SetAuditLogger(s)
	auditHandler := handlers.NewAuditHandler(s.audit)

	// Configure authentication middleware with CSRF protection
	authConfig := &middleware.AuthConfig{
		AuthService: s.authService,
		DevMode:     s.devMode,
		License:     s.licenseService,
		CSRFSecret:  csrfSecret,
	}
	// Setup guard ensures initial setup is complete before allowing access
	setupGuard := middleware.RequireSetupComplete(s.setupService)

	// Public routes (no authentication required)
	s.router.Group(func(r chi.Router) {
		// Health check endpoints for monitoring and orchestration
		r.Get("/health", healthHandler.HealthCheck)
		r.Get("/health/ready", healthHandler.ReadinessCheck)
		r.Get("/health/live", healthHandler.LivenessCheck)

		// Prometheus metrics endpoint (public for scraping)
		r.Get("/metrics", monitoringHandler.PrometheusMetrics)

		// API version info endpoint
		r.Get("/api/version", healthHandler.Version)
	})

	// API v1 routes
	s.router.Route("/api/v1", func(r chi.Router) {
		// Setup routes (public, but only work when setup is incomplete)
		r.Route("/setup", func(r chi.Router) {
			r.Get("/status", setupHandler.GetStatus)
			r.Post("/complete", setupHandler.CompleteSetup)
			r.Get("/preflight", setupHandler.Preflight)
		})

		// Public auth routes (login, register, refresh)
		r.Group(func(r chi.Router) {
			r.Use(setupGuard)
			r.Post("/auth/login", authHandler.Login)
			r.Post("/auth/register", authHandler.Register)
			r.Post("/auth/refresh", authHandler.RefreshToken)

		})

		// Protected routes (require authentication) - read-only operations
		r.Group(func(r chi.Router) {
			r.Use(setupGuard)
			r.Use(middleware.Auth(authConfig))
			// Add logout here temporarily until frontend sends CSRF tokens
			r.Post("/auth/logout", authHandler.Logout)
		})

		// CSRF-protected routes (authenticated users with CSRF tokens) - state-changing operations
		r.Group(func(r chi.Router) {
			r.Use(setupGuard)
			r.Use(middleware.Auth(authConfig))
			// CSRF protection on mutating routes
			r.Use(middleware.CSRF(authConfig.CSRFSecret))

			// Auth - authenticated user endpoints
			r.Get("/auth/me", authHandler.Me)
			r.Post("/auth/change-password", authHandler.ChangePassword)
			r.Get("/auth/csrf", csrfHandler.GetToken)

			// Catalog - browse available apps
			r.Route("/catalog", func(r chi.Router) {
				r.Get("/", catalogHandler.ListApps)
				r.Get("/categories", catalogHandler.GetCategories)
				r.Post("/refresh", catalogHandler.RefreshCatalog)
				r.Get("/{appId}", catalogHandler.GetApp)
			})

			scriptsHandler := handlers.NewScriptsHandler(s.appManager)

			// Apps management - installed apps
			r.Route("/apps", func(r chi.Router) {
				r.Get("/", appsHandler.ListInstalledApps)
				r.Post("/", appsHandler.InstallApp)
				r.Get("/updates/history", appsHandler.GetUpdateHistory)
				r.Get("/updates/available", appsHandler.GetAvailableUpdates)
				r.Get("/{instanceId}", appsHandler.GetInstalledApp)
				r.Delete("/{instanceId}", appsHandler.UninstallApp)
				r.Get("/{instanceId}/status", appsHandler.GetAppStatus)
				r.Post("/{instanceId}/start", appsHandler.StartApp)
				r.Post("/{instanceId}/stop", appsHandler.StopApp)
				r.Post("/{instanceId}/restart", appsHandler.RestartApp)
				r.Post("/{instanceId}/update", appsHandler.UpdateApp)
				r.Post("/{instanceId}/pin", appsHandler.PinAppVersion)
				r.Post("/{instanceId}/unpin", appsHandler.UnpinAppVersion)
				r.Get("/{instanceId}/updates/history", appsHandler.GetAppUpdateHistory)
				r.Get("/{instanceId}/actions", scriptsHandler.ListActions)
				r.Get("/{instanceId}/actions/{actionName}", scriptsHandler.GetAction)
				r.Post("/{instanceId}/actions/{actionName}/execute", scriptsHandler.ExecuteAction)
				r.Get("/{instanceId}/actions/{actionName}/stream", scriptsHandler.StreamAction)
			})

			// Monitoring - system health and metrics management
			r.Route("/monitoring", func(r chi.Router) {
				r.Get("/system", monitoringHandler.SystemHealth)
				r.Post("/cleanup", monitoringHandler.CleanupMetrics)
				r.Post("/email/test", monitoringHandler.SendTestEmail)
			})

			// Notification configuration (admin only)
			r.Route("/notify", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/config", notifyHandler.Get)
				r.Put("/config", notifyHandler.Update)
				r.Post("/preview", notifyHandler.Preview)
			})

			// License management (admin only)
			r.Route("/license", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/status", licenseHandler.Status)
			})

			// App-specific health and metrics (under /apps routes)
			r.Route("/apps/{appID}/health", func(r chi.Router) {
				r.Get("/", monitoringHandler.GetAppHealth)
				r.Post("/register", monitoringHandler.RegisterHealthCheck)
				r.Delete("/", monitoringHandler.UnregisterHealthCheck)
			})
			r.Get("/apps/{appID}/metrics", monitoringHandler.GetAppMetrics)
			r.Get("/apps/{appID}/metrics/history", monitoringHandler.GetMetricsHistory)

			// Backups - system and database backup management
			r.Route("/backups", func(r chi.Router) {
				r.Get("/", backupHandler.ListBackups)
				r.Post("/", backupHandler.CreateBackup)
				r.Get("/{backupID}", backupHandler.GetBackup)
				r.Post("/{backupID}/restore", backupHandler.RestoreBackup)
				r.Delete("/{backupID}", backupHandler.DeleteBackup)

				// Database backups
				r.Get("/database", backupHandler.ListDatabaseBackups)
				r.Post("/database", backupHandler.CreateDatabaseBackup)
				r.Post("/database/{backupID}/restore", backupHandler.RestoreDatabaseBackup)
			})

			// Network / Caddy - reverse proxy and routing management
			if networkHandler != nil {
				r.Route("/network", func(r chi.Router) {
					r.Get("/status", networkHandler.GetCaddyStatus)
					r.Get("/routes", networkHandler.ListRoutes)
					r.Post("/routes", networkHandler.CreateRoute)
					r.Post("/routes/check", networkHandler.CheckRouteAvailability)
					r.Get("/routes/{routeID}", networkHandler.GetRoute)
					r.Put("/routes/{routeID}", networkHandler.UpdateRoute)
					r.Delete("/routes/{routeID}", networkHandler.DeleteRoute)
					r.Get("/caddyfile", networkHandler.GetCaddyfile)
					r.Post("/test-backend", networkHandler.TestBackend)
				})
			}

			// Network probing - connectivity and DNS testing
			r.Route("/network/probe", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/dns", networkProbeHandler.DNS)
				r.Get("/tcp", networkProbeHandler.ProbeTCP)
			})

			// ACME certificate management
			r.Route("/network/acme", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Post("/probe-dns", acmeHandler.ProbeDNS)
				r.Post("/probe-ports", acmeHandler.ProbePorts)
				r.Post("/request", acmeHandler.RequestCert)
				r.Get("/jobs/{jobID}", acmeHandler.GetJob)
				r.Get("/status", acmeHandler.GetStatus)
				r.Delete("/routes/{routeID}", acmeCleanup.DeleteRoute)
			})

			// Job Queue management (admin only)
			if s.jobQueue != nil {
				jobQueueHandler := handlers.NewJobQueueHandler(s.jobQueue)
				r.Route("/jobs", func(r chi.Router) {
					r.Use(middleware.RequireRole("admin"))
					r.Get("/", jobQueueHandler.ListJobs)
					r.Get("/stats", jobQueueHandler.GetJobStats)
					r.Get("/running", jobQueueHandler.GetRunningJobs)
					r.Get("/status", jobQueueHandler.GetQueueStatus)
					r.Get("/{id}", jobQueueHandler.GetJob)
					r.Delete("/{id}", jobQueueHandler.CancelJob)
				})
			}

			// Users management (admin only)
			r.Route("/users", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/", usersHandler.ListUsers)
				r.Post("/", usersHandler.CreateUser)
				r.Get("/{userID}", usersHandler.GetUser)
				r.Put("/{userID}", usersHandler.UpdateUser)
				r.Delete("/{userID}", usersHandler.DeleteUser)
			})

			// Support sessions - remote support access management (admin only)
			r.Route("/support/sessions", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/", supportHandler.ListSessions)
				r.Post("/", supportHandler.CreateSession)
				r.Get("/{sessionID}", supportHandler.GetSession)
				r.Post("/{sessionID}/revoke", supportHandler.RevokeSession)
			})

			// Support diagnostics - system diagnostics collection (admin only)
			r.Route("/support/diagnostics", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/", supportDiagHandler.Get)
			})

			// Support session validation - file and command execution (admin only)
			r.Route("/support/session", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Post("/validate", supportSessionValidator.Validate)
				r.Post("/files/read", supportFileHandler.Read)
				r.Post("/files/write", supportFileHandler.Write)
				r.Post("/command", supportCommandHandler.Run)
			})

			// Settings - application configuration
			r.Route("/settings", func(r chi.Router) {
				r.Get("/", settingsHandler.Get)
				r.Put("/", settingsHandler.Update)
			})

			// System updates (admin only)
			r.Route("/system", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/updates/check", systemHandler.CheckUpdates)
				r.Post("/updates/apply", systemHandler.ApplyUpdate)
			})

			// Audit logs (admin only)
			r.Route("/audit", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/", auditHandler.ListLogs)
			})

			// Security monitoring (authenticated users)
			r.Route("/security", func(r chi.Router) {
				// Apply rate limiting: 60 requests per minute per user
				r.Use(middleware.RateLimit([]middleware.RateRule{
					{Prefix: "/api/v1/security", Limit: 60, Window: time.Minute},
				}))

				// Settings - available to all authenticated users
				r.Get("/settings", securityHandler.GetSettings)
				r.Put("/settings", securityHandler.UpdateSettings)
				r.Post("/test-notification", securityHandler.TestNotification)

				// Events - users can see their own events, admins see all
				r.Get("/events", securityHandler.ListEvents)

				// Stats - admin only
				r.With(middleware.RequireRole("admin")).Get("/stats", securityHandler.GetStats)

				// Health - check security service health and metrics (admin only)
				r.With(middleware.RequireRole("admin")).Get("/health", securityHandler.GetHealth)
			})
		})
	})

	// Serve static frontend (SPA) for all other routes
	s.router.Handle("/assets/*", s.assetsHandler)
	s.router.Handle("/", http.HandlerFunc(s.serveSPA))
	s.router.Handle("/*", http.HandlerFunc(s.serveSPA))
	s.router.NotFound(http.HandlerFunc(s.serveSPA))
}

// notImplemented is a placeholder handler for routes not yet implemented
//
//lint:ignore U1000 Reserved for future use
func (s *Server) notImplemented(w http.ResponseWriter, r *http.Request) {
	handlers.JSONError(w, http.StatusNotImplemented, "This endpoint is not yet implemented")
}
