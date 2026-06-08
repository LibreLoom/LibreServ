package api

import (
	"database/sql"
	"log/slog"
	"net/http"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/handlers"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
)

// Server holds all HTTP dependencies and routes.
type Server struct {
	db     *sql.DB
	router *chi.Mux
}

// NewServer creates and wires the HTTP server.
func NewServer(db *sql.DB) *Server {
	s := &Server{db: db}
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
	// TODO: add CORS when frontends land

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
	})

	// Support & inference (device auth required)
	r.Route("/api/v1/cases", func(r chi.Router) {
		r.Use(middleware.DeviceAuth(s.db))
		r.Get("/", handlers.NewSupportHandler(s.db).ListCases)
		r.Post("/", handlers.NewSupportHandler(s.db).CreateCase)
	})

	// Admin routes (separate auth)
	r.Route("/admin", func(r chi.Router) {
		r.Use(middleware.AdminAuth)

		// Devices
		r.Get("/devices", handlers.NewAdminHandler(s.db).ListDevices)
		r.Get("/devices/{deviceID}", handlers.NewAdminHandler(s.db).GetDevice)
		r.Get("/devices/{deviceID}/usage", handlers.NewAdminHandler(s.db).GetDeviceUsage)
		r.Post("/devices/{deviceID}/credentials/rotate", handlers.NewAdminHandler(s.db).RotateCredentials)

		// Cases
		r.Get("/cases", handlers.NewAdminHandler(s.db).ListCases)
		r.Get("/cases/{caseID}", handlers.NewAdminHandler(s.db).GetCase)
		r.Post("/cases/{caseID}/messages", handlers.NewAdminHandler(s.db).AddCaseMessage)
		r.Post("/cases/{caseID}/consent-requests", handlers.NewAdminHandler(s.db).CreateConsentRequest)

		// Plans
		r.Get("/plans", handlers.NewAdminHandler(s.db).ListPlans)
		r.Put("/plans/{planID}", handlers.NewAdminHandler(s.db).UpdatePlan)
	})

	s.router = r
	slog.Info("routes registered")
}
