package api

import (
	"database/sql"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/handlers"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/models"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/smtp"
)

// Server holds all HTTP dependencies and routes.
type Server struct {
	db        *sql.DB
	router    *chi.Mux
	billing   *billing.Service
	models    *models.Service
	providers *providers.Service
	adminFS   http.FileSystem
	custFS    http.FileSystem
	smtpSrv   *smtp.Server
}

// NewServer creates and wires the HTTP server.
func NewServer(db *sql.DB) *Server {
	provSvc := providers.NewService(db)
	resend := providers.NewResendClient(nil)

	s := &Server{
		db:        db,
		billing:   billing.NewService(db),
		models:    models.NewService(db),
		providers: provSvc,
	}
	s.adminFS = openStaticFS(config.C.Web.AdminDir)
	s.custFS = openStaticFS(config.C.Web.CustomerDir)
	s.setupRoutes()

	// Start the SMTP relay server (authenticates device connections, forwards to Resend)
	s.smtpSrv = smtp.NewServer(db, resend, func() string {
		prov, err := provSvc.FindEnabled("smtp")
		if err != nil || prov == nil {
			return ""
		}
		return prov.Credential("api_key", "")
	})
	if err := s.smtpSrv.Start(); err != nil {
		slog.Warn("smtp relay failed to start", "error", err)
	}

	return s
}

// StopSMTP gracefully shuts down the SMTP relay server.
func (s *Server) StopSMTP() {
	if s.smtpSrv != nil {
		s.smtpSrv.Stop()
	}
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
			r.Post("/routes", handlers.NewProvisionHandler(s.db).RegisterRoute)
			r.Delete("/routes", handlers.NewProvisionHandler(s.db).UnregisterRoute)
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
		r.Post("/verify-email", portal.VerifyEmail)
		r.Get("/plans", portal.GetPlans)

		// Authenticated routes
		r.Group(func(r chi.Router) {
			r.Use(middleware.SPAFallback(s.serveCustomerSPA))
			r.Use(middleware.CustomerAuth(s.db))

			// Reachable without a verified email so unverified users can
			// manage verification itself.
			r.Post("/resend-verification", portal.ResendVerification)
			r.Get("/verification-status", portal.GetVerificationStatus)
			r.Get("/me", portal.GetMe)

			// Everything below requires a verified email — no account
			// activity is allowed until the address is confirmed.
			r.Group(func(r chi.Router) {
				r.Use(middleware.RequireVerifiedEmail(s.db))

				// Devices
				r.Get("/devices", portal.GetDevices)
				r.Get("/connect-keys", portal.GetConnectKeys)
				r.Post("/connect-keys", portal.GenerateConnectKey)
				r.Post("/connect-keys/revoke", portal.RevokeConnectKey)

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

				// Domains
				r.Post("/domains/search", portal.SearchDomains)
				r.Post("/domains/check", portal.CheckDomain)
				r.Post("/domains/register", portal.RegisterDomain)
				r.Get("/domains", portal.ListDomains)

				// Consent
				r.Get("/consent", portal.GetConsentRequests)
				r.Post("/consent/respond", portal.RespondConsent)
			})
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
			// Browser navigation (Accept: text/html) to any admin path serves
			// the SPA so deep links work on hard refresh. API calls send
			// Accept: */* and pass through to auth.
			r.Use(middleware.SPAFallback(s.serveAdminSPA))
			r.Use(middleware.AdminAuth(s.db))

			admin := handlers.NewAdminHandler(s.db)

			// 2FA
			r.Post("/2fa/setup", authHandler.Setup2FA)
			r.Post("/2fa/verify", authHandler.Verify2FA)

			// Security — password + admin management
			r.Post("/password", authHandler.ChangePassword)
			r.Get("/admins", authHandler.ListAdmins)
			r.Post("/admins", authHandler.CreateAdmin)
			r.Delete("/admins/{adminID}", authHandler.DeleteAdmin)

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

			// Tunnels
			r.Get("/tunnels", admin.ListTunnels)

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
		})

		// Admin SPA: serve index.html for any unmatched path under /admin.
		// API routes above are matched first; only browser navigation reaches here.
		r.Get("/*", s.serveAdminSPA)
		r.NotFound(s.serveAdminSPA)
	})

	// Customer SPA: serve index.html for any unmatched path.
	// API routes above are matched first; only browser navigation reaches here.
	r.Get("/*", s.serveCustomerSPA)
	r.NotFound(s.serveCustomerSPA)

	s.router = r
	slog.Info("routes registered")
}

// openStaticFS opens a directory for static file serving. If the directory
// does not exist (e.g. dist not built yet), it returns nil and the server
// skips static serving for that UI.
func openStaticFS(dir string) http.FileSystem {
	if dir == "" {
		return nil
	}
	if info, err := os.Stat(dir); err != nil || !info.IsDir() {
		slog.Warn("static directory not found, skipping", "dir", dir)
		return nil
	}
	return http.Dir(dir)
}

// serveAdminSPA serves the admin web UI from adminFS with index.html fallback
// for client-side routing.
func (s *Server) serveAdminSPA(w http.ResponseWriter, r *http.Request) {
	if s.adminFS == nil {
		http.NotFound(w, r)
		return
	}
	// Strip the /admin prefix so paths resolve relative to the dist root.
	rel := strings.TrimPrefix(r.URL.Path, "/admin")
	rel = strings.TrimPrefix(rel, "/")
	s.serveStatic(w, r, s.adminFS, rel)
}

// serveCustomerSPA serves the customer web UI from custFS with index.html
// fallback for client-side routing.
func (s *Server) serveCustomerSPA(w http.ResponseWriter, r *http.Request) {
	if s.custFS == nil {
		http.NotFound(w, r)
		return
	}
	rel := strings.TrimPrefix(r.URL.Path, "/")
	s.serveStatic(w, r, s.custFS, rel)
}

// serveStatic serves a file from the given filesystem, falling back to
// index.html for SPA routes (paths without a file extension).
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request, fsys http.FileSystem, rel string) {
	if rel == "" || rel == "." {
		rel = "index.html"
	}

	// SPA fallback: if the path has no file extension and the file doesn't
	// exist, serve index.html so the client-side router can handle it.
	if path.Ext(rel) == "" {
		if _, err := fsys.Open(rel); err != nil {
			rel = "index.html"
		}
	}

	// Security: prevent directory traversal. http.FileServer already guards
	// against this, but we set the path explicitly for clarity.
	f, err := fsys.Open(rel)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()

	stat, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}

	// Prevent browser caching of SPA HTML responses. index.html is the SPA
	// entry point — if the browser caches it, it loads stale JS bundle
	// hashes after a deploy. SPA fallback routes (no extension) also need
	// no-store so fetch() calls don't receive cached HTML.
	if rel == "index.html" || path.Ext(rel) == "" {
		w.Header().Set("Cache-Control", "no-store, must-revalidate")
	}
	http.ServeContent(w, r, stat.Name(), stat.ModTime(), f.(io.ReadSeeker))
}
