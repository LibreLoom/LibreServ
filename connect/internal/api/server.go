package api

import (
	"database/sql"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/handlers"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/models"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/relay"
)

// Server holds all HTTP dependencies and routes.
type Server struct {
	db        *sql.DB
	router    *chi.Mux
	billing   *billing.Service
	models    *models.Service
	relay     *relay.Service
	providers *providers.Service
}

// NewServer creates and wires the HTTP server.
func NewServer(db *sql.DB) *Server {
	s := &Server{
		db:        db,
		billing:   billing.NewService(db),
		models:    models.NewService(db),
		relay:     relay.NewService(db),
		providers: providers.NewService(db),
	}
	s.setupRoutes()
	return s
}

// Router returns the chi mux for serving.
func (s *Server) Router() *chi.Mux {
	return s.router
}

func (s *Server) setupRoutes() {
	r := chi.NewRouter()

	// Global middleware
	r.Use(middleware.Logger)
	r.Use(middleware.Recoverer)

	// Health
	r.Get("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(200)
		w.Write([]byte("ok"))
	})

	// Device-facing API
	r.Route("/api/v1", func(r chi.Router) {
		// No auth required for activate/info
		r.Post("/activate", handlers.NewDeviceHandler(s.db).Activate)
		r.Get("/info", handlers.NewProvisionHandler(s.db).Info)

		// Device auth required for everything else
		r.Group(func(r chi.Router) {
			r.Use(middleware.DeviceAuth(s.db))

			r.Post("/deactivate", handlers.NewDeviceHandler(s.db).Deactivate)
			r.Get("/status", handlers.NewDeviceHandler(s.db).Status)
			r.Get("/usage", handlers.NewDeviceHandler(s.db).Usage)
			r.Post("/services/provision", handlers.NewProvisionHandler(s.db).Provision)
		})

		// Support & inference (device auth required)
		r.Route("/cases", func(r chi.Router) {
			r.Use(middleware.DeviceAuth(s.db))
			r.Get("/", handlers.NewSupportHandler(s.db).ListCases)
			r.Post("/", handlers.NewSupportHandler(s.db).CreateCase)
		})
	})

	// Customer portal API
	r.Route("/portal", func(r chi.Router) {
		portal := handlers.NewPortalHandler(s.db)

		// Public routes
		r.Post("/register", portal.Register)
		r.Post("/login", portal.Login)
		r.Get("/plans", portal.GetPlans)

		// Authenticated routes
		r.Group(func(r chi.Router) {
			r.Use(middleware.CustomerAuth(s.db))

			// Devices
			r.Get("/devices", portal.GetDevices)
			r.Get("/license-keys", portal.GetLicenseKeys)
			r.Post("/license-keys", portal.GenerateLicenseKey)
			r.Post("/license-keys/revoke", portal.RevokeLicenseKey)

			// 2FA
			r.Post("/2fa/setup", portal.Setup2FA)
			r.Post("/2fa/verify", portal.Verify2FA)
			r.Post("/2fa/disable", portal.Disable2FA)

			// Usage & billing
			r.Get("/usage", portal.GetUsage)
			r.Get("/billing", portal.GetBilling)
			r.Post("/subscribe", portal.Subscribe)
			r.Post("/cancel", portal.Cancel)
			r.Post("/change-plan", portal.ChangePlan)

			r.Post("/checkout", portal.CreateCheckoutSession)
			r.Post("/billing-portal", portal.BillingPortal)

			// Consent
			r.Get("/consent", portal.GetConsentRequests)
			r.Post("/consent/respond", portal.RespondConsent)
		})
	})

	// Billing webhooks (Stripe)
	r.Post("/webhooks/stripe", handlers.NewBillingHandler(s.billing).StripeWebhook)

	// Admin routes (separate auth)
	r.Route("/admin", func(r chi.Router) {
		// Public admin routes (login, seed)
		authHandler := handlers.NewAdminAuthHandler(s.db)
		r.Post("/login", authHandler.Login)
		r.Post("/seed", authHandler.SeedAdmin)

		// Authenticated admin routes
		r.Group(func(r chi.Router) {
			r.Use(middleware.AdminAuth(s.db))

			admin := handlers.NewAdminHandler(s.db)

			// 2FA
			r.Post("/2fa/setup", authHandler.Setup2FA)
			r.Post("/2fa/verify", authHandler.Verify2FA)

			// Devices
			r.Get("/devices", admin.ListDevices)
			r.Get("/devices/{deviceID}", admin.GetDevice)
			r.Get("/devices/{deviceID}/usage", admin.GetDeviceUsage)
			r.Post("/devices/{deviceID}/credentials/rotate", admin.RotateCredentials)

			// Cases
			r.Get("/cases", admin.ListCases)
			r.Get("/cases/{caseID}", admin.GetCase)
			r.Post("/cases/{caseID}/messages", admin.AddCaseMessage)
			r.Post("/cases/{caseID}/consent-requests", admin.CreateConsentRequest)

			// Plans
			r.Get("/plans", admin.ListPlans)
			r.Put("/plans/{planID}", admin.UpdatePlan)

			// Usage (aggregated)
			r.Get("/usage", admin.GetAggregatedUsage)

			// Service provider config
			ph := handlers.NewProvidersHandler(s.providers)
			r.Get("/providers", ph.ListProviders)
			r.Post("/providers", ph.CreateProvider)
			r.Put("/providers/{id}", ph.UpdateProvider)
			r.Delete("/providers/{id}", ph.DeleteProvider)

			// AI Models config
			mh := handlers.NewModelsHandler(s.models)
			r.Get("/models/providers", mh.ListProviders)
			r.Post("/models/providers", mh.CreateProvider)
			r.Put("/models/providers/{id}", mh.UpdateProvider)
			r.Delete("/models/providers/{id}", mh.DeleteProvider)
			r.Get("/models", mh.ListModels)
			r.Post("/models", mh.CreateModel)
			r.Put("/models/{id}", mh.UpdateModel)
			r.Delete("/models/{id}", mh.DeleteModel)
			r.Get("/models/fallback/{role}", mh.GetFallbackChain)
			r.Post("/models/fallback/{role}", mh.SetFallbackChain)

			// Relay fleet
			rh := handlers.NewRelayHandler(s.relay)
			r.Get("/relay", rh.GetFleetStatus)
			r.Get("/relay/regions", rh.ListRegions)
			r.Post("/relay/regions", rh.CreateRegion)
			r.Put("/relay/regions/{id}/health", rh.UpdateRegionHealth)
			r.Delete("/relay/regions/{id}", rh.DeleteRegion)
		})
	})

	s.router = r
	slog.Info("routes registered")
}
