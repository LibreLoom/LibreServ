package api

import (
	"net/http"
	"path/filepath"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

// setupRoutes configures all API routes
func (s *Server) setupRoutes() {
	// Rate limiting
	s.router.Use(middleware.RateLimitDefault())

	// Handlers
	healthHandler := handlers.NewHealthHandler(s.db)
	catalogHandler := handlers.NewCatalogHandler(s.appManager)
	appsHandler := handlers.NewAppsHandler(s.appManager)
	authHandler := handlers.NewAuthHandler(s.authService)
	setupHandler := handlers.NewSetupHandler(s.authService, s.setupService, s.dockerClient, s.licenseService)
	monitoringHandler := handlers.NewMonitoringHandlers(s.monitor, s.db, s.dockerClient)
	backupHandler := handlers.NewBackupHandlers(s.backupService)
	usersHandler := handlers.NewUsersHandler(s.authService)
	settingsHandler := handlers.NewSettingsHandler()
	csrfSecret := config.Get().Auth.CSRFSecret
	csrfHandler := handlers.NewCSRFHandler(csrfSecret)
	networkProbeHandler := handlers.NewNetworkProbeHandler()
	adminAPI := ""
	configPath := ""
	if s.caddyManager != nil {
		adminAPI = s.caddyManager.AdminEndpoint()
		configPath = s.caddyManager.ConfigPath()
	}
	acmeManager := network.NewACMEManager(adminAPI, configPath).WithAuto(true)
	acmeHandler := handlers.NewACMEHandler(acmeManager, s.caddyManager, s.appManager)
	acmeCleanup := handlers.NewACMECleanupHandler(s.caddyManager)
	var networkHandler *handlers.NetworkHandlers
	if s.caddyManager != nil {
		networkHandler = handlers.NewNetworkHandlers(s.caddyManager, s.appManager).WithACME(acmeHandler)
	}
	supportHandler := handlers.NewSupportHandler(s.supportService, s.licenseService)
	supportDiagHandler := handlers.NewSupportDiagnosticsHandler(s.authService, s.dockerClient)
	supportSessionValidator := handlers.NewSupportSessionValidationHandler(s.supportService)
	supportFileHandler := handlers.NewSupportFileHandler(s.supportService)
	supportCommandHandler := handlers.NewSupportCommandHandler(s.supportService)
	notifyHandler := handlers.NewNotifyHandler()
	licenseHandler := handlers.NewLicenseHandler(s.licenseService)

	// Auth middleware config
	authConfig := &middleware.AuthConfig{
		AuthService: s.authService,
		DevMode:     s.devMode,
		License:     s.licenseService,
		CSRFSecret:  csrfSecret,
	}
	setupGuard := middleware.RequireSetupComplete(s.setupService)

	// Public routes (no authentication required)
	s.router.Group(func(r chi.Router) {
		// Health check endpoints
		r.Get("/health", healthHandler.HealthCheck)
		r.Get("/health/ready", healthHandler.ReadinessCheck)
		r.Get("/health/live", healthHandler.LivenessCheck)

		// API version info
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

		// Public auth routes
		r.Group(func(r chi.Router) {
			r.Use(setupGuard)
			r.Post("/auth/login", authHandler.Login)
			r.Post("/auth/register", authHandler.Register)
			r.Post("/auth/refresh", authHandler.RefreshToken)
			r.Get("/auth/csrf", csrfHandler.GetToken)
		})

		// Protected routes (require authentication)
		r.Group(func(r chi.Router) {
			r.Use(setupGuard)
			r.Use(middleware.Auth(authConfig))
			// CSRF protection on mutating routes
			r.Use(middleware.CSRF(authConfig.CSRFSecret))

			// Auth - authenticated user endpoints
			r.Get("/auth/me", authHandler.Me)
			r.Post("/auth/change-password", authHandler.ChangePassword)

			// Catalog - browse available apps
			r.Route("/catalog", func(r chi.Router) {
				r.Get("/", catalogHandler.ListApps)
				r.Get("/categories", catalogHandler.GetCategories)
				r.Post("/refresh", catalogHandler.RefreshCatalog)
				r.Get("/{appId}", catalogHandler.GetApp)
			})

			// Apps management - installed apps
			r.Route("/apps", func(r chi.Router) {
				r.Get("/", appsHandler.ListInstalledApps)
				r.Post("/", appsHandler.InstallApp)
				r.Get("/{instanceId}", appsHandler.GetInstalledApp)
				r.Delete("/{instanceId}", appsHandler.UninstallApp)
				r.Get("/{instanceId}/status", appsHandler.GetAppStatus)
				r.Post("/{instanceId}/start", appsHandler.StartApp)
				r.Post("/{instanceId}/stop", appsHandler.StopApp)
				r.Post("/{instanceId}/restart", appsHandler.RestartApp)
				r.Post("/{instanceId}/update", appsHandler.UpdateApp)
			})

			// Monitoring
			r.Route("/monitoring", func(r chi.Router) {
				r.Get("/system", monitoringHandler.SystemHealth)
				r.Post("/cleanup", monitoringHandler.CleanupMetrics)
				r.Post("/email/test", monitoringHandler.SendTestEmail)
			})

			r.Route("/notify", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/config", notifyHandler.Get)
				r.Put("/config", notifyHandler.Update)
				r.Post("/preview", notifyHandler.Preview)
			})

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

			// Backups
			r.Route("/backups", func(r chi.Router) {
				r.Get("/", backupHandler.ListBackups)
				r.Post("/", backupHandler.CreateBackup)
				r.Get("/{backupID}", backupHandler.GetBackup)
				r.Post("/{backupID}/restore", backupHandler.RestoreBackup)
				r.Delete("/{backupID}", backupHandler.DeleteBackup)

				// Database backups
				r.Get("/database", backupHandler.ListDatabaseBackups)
				r.Post("/database", backupHandler.CreateDatabaseBackup)
			})

			// Network / Caddy
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
			r.Route("/network/probe", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/dns", networkProbeHandler.DNS)
				r.Get("/tcp", networkProbeHandler.ProbeTCP)
			})
			r.Route("/network/acme", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Post("/probe-dns", acmeHandler.ProbeDNS)
				r.Post("/probe-ports", acmeHandler.ProbePorts)
				r.Post("/request", acmeHandler.RequestCert)
				r.Delete("/routes/{routeID}", acmeCleanup.DeleteRoute)
			})

			// Users (admin only)
			r.Route("/users", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/", usersHandler.ListUsers)
				r.Post("/", usersHandler.CreateUser)
				r.Get("/{userID}", usersHandler.GetUser)
				r.Put("/{userID}", usersHandler.UpdateUser)
				r.Delete("/{userID}", usersHandler.DeleteUser)
			})

			// Support sessions (admin only)
			r.Route("/support/sessions", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/", supportHandler.ListSessions)
				r.Post("/", supportHandler.CreateSession)
				r.Get("/{sessionID}", supportHandler.GetSession)
				r.Post("/{sessionID}/revoke", supportHandler.RevokeSession)
			})

			// Support diagnostics (admin only)
			r.Route("/support/diagnostics", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/", supportDiagHandler.Get)
			})

			// Support session validation (admin only for now)
			r.Route("/support/session", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Post("/validate", supportSessionValidator.Validate)
				r.Post("/files/read", supportFileHandler.Read)
				r.Post("/files/write", supportFileHandler.Write)
				r.Post("/command", supportCommandHandler.Run)
			})

			// Settings
			r.Route("/settings", func(r chi.Router) {
				r.Get("/", settingsHandler.Get)
				r.Put("/", settingsHandler.Update)
			})
		})
	})

	// Serve static frontend (SPA) for all other routes
	s.router.Handle("/assets/*", http.StripPrefix("/assets/", http.FileServer(http.Dir(filepath.Join(s.staticDir, "assets")))))
	s.router.Handle("/", http.HandlerFunc(s.serveSPA))
	s.router.Handle("/*", http.HandlerFunc(s.serveSPA))
	s.router.NotFound(http.HandlerFunc(s.serveSPA))
}

// notImplemented is a placeholder handler for routes not yet implemented
func (s *Server) notImplemented(w http.ResponseWriter, r *http.Request) {
	handlers.JSONError(w, http.StatusNotImplemented, "This endpoint is not yet implemented")
}
