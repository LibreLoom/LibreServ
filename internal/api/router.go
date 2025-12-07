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
		// Public auth routes
		r.Group(func(r chi.Router) {
			r.Post("/auth/login", s.notImplemented)
		})

		// Protected routes (require authentication)
		r.Group(func(r chi.Router) {
			r.Use(middleware.Auth())

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
				r.Get("/stats", s.notImplemented)     // Overall system stats
				r.Get("/apps/{appID}/metrics", s.notImplemented)
				r.Get("/apps/{appID}/logs", s.notImplemented)
			})

			// Backups
			r.Route("/backups", func(r chi.Router) {
				r.Get("/", s.notImplemented)          // List backups
				r.Post("/", s.notImplemented)         // Create backup
				r.Post("/{backupID}/restore", s.notImplemented)
				r.Delete("/{backupID}", s.notImplemented)
			})

			// Users (admin only)
			r.Route("/users", func(r chi.Router) {
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
