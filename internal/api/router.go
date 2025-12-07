package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
)

// setupRoutes configures all API routes
func (s *Server) setupRoutes() {
	// Handlers
	healthHandler := handlers.NewHealthHandler(s.db)
	catalogHandler := handlers.NewCatalogHandler(s.appManager)
	appsHandler := handlers.NewAppsHandler(s.appManager)
	authHandler := handlers.NewAuthHandler(s.authService)
	setupHandler := handlers.NewSetupHandler(s.authService)
	monitoringHandler := handlers.NewMonitoringHandlers(s.monitor)
	backupHandler := handlers.NewBackupHandlers(s.backupService)

	// Auth middleware config
	authConfig := &middleware.AuthConfig{
		AuthService: s.authService,
		DevMode:     s.devMode,
	}

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
		})

		// Public auth routes
		r.Group(func(r chi.Router) {
			r.Post("/auth/login", authHandler.Login)
			r.Post("/auth/register", authHandler.Register)
			r.Post("/auth/refresh", authHandler.RefreshToken)
		})

		// Protected routes (require authentication)
		r.Group(func(r chi.Router) {
			r.Use(middleware.Auth(authConfig))

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

			// Users (admin only)
			r.Route("/users", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/", s.notImplemented)
				r.Post("/", s.notImplemented)
				r.Get("/{userID}", s.notImplemented)
				r.Put("/{userID}", s.notImplemented)
				r.Delete("/{userID}", s.notImplemented)
			})

			// Settings
			r.Route("/settings", func(r chi.Router) {
				r.Get("/", s.notImplemented)
				r.Put("/", s.notImplemented)
			})
		})
	})
}

// notImplemented is a placeholder handler for routes not yet implemented
func (s *Server) notImplemented(w http.ResponseWriter, r *http.Request) {
	handlers.JSONError(w, http.StatusNotImplemented, "This endpoint is not yet implemented")
}
