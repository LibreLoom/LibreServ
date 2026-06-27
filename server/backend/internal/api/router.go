package api

import (
	"net/http"
	"os"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/podman"
)

// setupRoutes configures all API routes
func (s *Server) setupRoutes() {
	// Apply rate limiting middleware globally to all routes
	s.router.Use(middleware.RateLimitDefault())

	// Initialize all route handlers with required dependencies
	healthHandler := handlers.NewHealthHandler(s.db)
	catalogHandler := handlers.NewCatalogHandler(s.appManager)
	reposHandler := handlers.NewReposHandler(s.appManager, config.Get())
	appsHandler := handlers.NewAppsHandler(s.appManager)
	appsHandler.SetAuditLogger(s)
	authHandler := handlers.NewAuthHandler(s.authService, s.securityService, s.db)
	securityHandler := handlers.NewSecurityHandler(s.securityService)
	monitoringHandler := handlers.NewMonitoringHandlers(s.monitor, s.db, s.runtimeClient, s.appManager.GetMetricsCache())
	backupHandler := handlers.NewBackupHandlers(s.backupService)
	usersHandler := handlers.NewUsersHandler(s.authService)
	apiTokensHandler := handlers.NewAPITokensHandler(s.authService)
	apiTokensHandler.SetAuditLogger(s)
	mfaHandler := handlers.NewMFAHandler(s.authService, mfaEmailSender(s.emailSender))
	settingsHandler := handlers.NewSettingsHandler(s.settingsService, s.securityService, s.caddyManager)
	csrfSecret := config.Get().Auth.CSRFSecret
	csrfHandler := handlers.NewCSRFHandler(csrfSecret)
	networkProbeHandler := handlers.NewNetworkProbeHandler()

	// ACME manager is supplied by the application bootstrap (cmd/libreserv/main.go)
	// as a single shared instance so background jobs and HTTP handlers never drift
	// on Auto/External settings. Only metrics wiring happens here.

	// Initialize Caddy metrics collector
	caddyMetrics := monitoring.NewCaddyMetrics()

	// Wire metrics into Caddy manager if available
	if s.caddyManager != nil {
		s.caddyManager.WithMetrics(caddyMetrics)
	}
	if s.acmeManager != nil {
		s.acmeManager.WithMetrics(caddyMetrics)
	}

	acmeHandler := handlers.NewACMEHandler(s.db, s.acmeManager, s.caddyManager, s.appManager)
	// Wire in job queue if available
	if s.jobQueue != nil {
		acmeHandler = acmeHandler.WithJobQueue(s.jobQueue)
	}
	acmeCleanup := handlers.NewACMECleanupHandler(s.caddyManager)

	// Initialize network handler if Caddy is available
	var networkHandler *handlers.NetworkHandlers
	if s.caddyManager != nil {
		upnpService := s.appManager.GetUPnPService()
		networkHandler = handlers.NewNetworkHandlers(s.caddyManager, s.appManager, upnpService).WithACME(acmeHandler)
	}

	// Initialize DNS provider manager
	s.dnsProviderMgr = network.NewDNSProviderManager(s.db)

	// Initialize setup handler with all required dependencies
	setupHandler := handlers.NewSetupHandler(s.authService, s.setupService, s.runtimeClient, s.licenseService, s.dnsProviderMgr, s.acmeManager, s.caddyManager, s.settingsService)

	// Initialize support and system handlers
	supportHandler := handlers.NewSupportHandler(s.supportService, s.licenseService)
	supportDiagHandler := handlers.NewSupportDiagnosticsHandler(s.authService, s.runtimeClient)
	supportSessionValidator := handlers.NewSupportSessionValidationHandler(s.supportService)
	supportFileHandler := handlers.NewSupportFileHandler(s.supportService)
	supportCommandHandler := handlers.NewSupportCommandHandler(s.supportService)
	licenseHandler := handlers.NewLicenseHandler(s.licenseService)
	systemHandler := handlers.NewSystemHandler(s.sysChecker)
	systemHandler.SetAuditLogger(s)
	auditHandler := handlers.NewAuditHandler(s.audit)
	factoryResetHandler := handlers.NewFactoryResetHandler(s.db, s.setupService, s.authService)
	ddnsHandler := handlers.NewDDNSHandler(s.ddnsService)
	connectivityHandler := handlers.NewConnectivityHandler(s.ddnsService, s.appManager.GetUPnPService(), s.appManager, s.caddyManager)
	tunnelHandler := handlers.NewTunnelHandler(s.tunnelService)

	// Initialize Connect handler
	connectHandler := handlers.NewConnectHandler(s.connectClient, s.connectChecker, s.settingsService)

	// Initialize AI agent chat handler
	agentChatHandler := handlers.NewAgentChatHandler(s.db, s.authService, s.connectClient, s.connectChecker)

	// Wire the AI model source into settings so the AI support category can list models dynamically
	settingsHandler.SetModelSource(agentChatHandler.ModelsSource())

	// Configure authentication middleware with CSRF protection
	authConfig := &middleware.AuthConfig{
		AuthService: s.authService,
		DevMode:     s.devMode,
		License:     s.licenseService,
		CSRFSecret:  csrfSecret,
	}
	// Setup guard ensures initial setup is complete before allowing access
	setupGuard := middleware.RequireSetupComplete(s.setupService, s.authService)
	setupAccess := middleware.SetupAccess(s.setupService)

	// Public routes (no authentication required)
	s.router.Group(func(r chi.Router) {
		// Health check endpoints for monitoring and orchestration
		r.Get("/health", healthHandler.HealthCheck)
		r.Get("/health/ready", healthHandler.ReadinessCheck)
		r.Get("/health/live", healthHandler.LivenessCheck)

		// Comprehensive health check (public so dashboard and monitoring can display failures)
		r.Get("/api/v1/system/health/check", monitoringHandler.ComprehensiveHealthCheck)
		r.Post("/api/v1/system/health/check/refresh", monitoringHandler.ComprehensiveHealthCheck)

		// Prometheus metrics endpoint (public with rate limiting)
		// NOTE: In production, restrict access via reverse proxy or move behind auth
		r.With(middleware.RateLimit([]middleware.RateRule{
			{Prefix: "/metrics", Limit: 30, Window: time.Minute},
		})).Get("/metrics", monitoringHandler.PrometheusMetrics)

		// API version info endpoint
		r.Get("/api/version", healthHandler.Version)
	})

	// API v1 routes
	s.router.Route("/api/v1", func(r chi.Router) {
		// Setup routes (public, but only work when setup is incomplete)
		r.Route("/setup", func(r chi.Router) {
			r.Get("/status", setupHandler.GetStatus)
			r.With(middleware.RateLimit([]middleware.RateRule{
				{Prefix: "/api/v1/setup/validate-code", Limit: 5, Window: time.Minute},
			})).Post("/validate-code", setupHandler.ValidateCode)
			r.With(setupAccess).Post("/complete", setupHandler.CompleteSetup)
			r.Get("/preflight", setupHandler.Preflight)
			r.With(setupAccess).Put("/progress", setupHandler.SaveProgress)
			r.With(setupAccess).Post("/progress/reset", setupHandler.ResetProgress)
			r.With(setupAccess).Post("/dns/test", setupHandler.TestDNS)
			r.With(setupAccess).Post("/dns/apply", setupHandler.ApplyDNS)
			r.Get("/dns/status", setupHandler.GetDNSStatus)
			r.With(setupAccess).Put("/smtp", setupHandler.SaveSMTP)
			r.With(setupAccess).Post("/smtp/test", setupHandler.TestSMTP)
			r.With(setupAccess).Post("/finalize", setupHandler.FinalizeSetup)
		})

		// Public auth routes (login, register, password reset, token refresh)
		r.Group(func(r chi.Router) {
			r.Use(setupGuard)
			// Rate limiting specific to auth endpoints to prevent brute-force attacks
			r.With(middleware.RateLimit([]middleware.RateRule{
				{Prefix: "/api/v1/auth/login", Limit: 10, Window: time.Minute},
			})).Post("/auth/login", authHandler.Login)
			r.With(middleware.RateLimit([]middleware.RateRule{
				{Prefix: "/api/v1/auth/register", Limit: 3, Window: time.Hour},
			})).Post("/auth/register", authHandler.Register)

			// Password reset endpoints (no auth required - token-based authentication)
			r.With(middleware.RateLimit([]middleware.RateRule{
				{Prefix: "/api/v1/auth/password-reset", Limit: 5, Window: time.Minute},
			})).Post("/auth/password-reset/request", authHandler.RequestPasswordReset)
			r.Post("/auth/password-reset/confirm", authHandler.ConfirmPasswordReset)
			r.Post("/auth/password-reset/validate", authHandler.ValidateResetToken)
			r.Get("/auth/password-reset/validate", authHandler.ValidateResetToken)

			// Token refresh (no access token required - uses refresh token cookie)
			r.Post("/auth/refresh", authHandler.RefreshToken)

			// MFA login flow — PUBLIC (auth'd by the short-lived mfa_token in the
			// body, not a session). Continuation of /auth/login for MFA-enabled users.
			r.Post("/auth/mfa/challenge", mfaHandler.Challenge)
			r.Post("/auth/mfa/verify", mfaHandler.Verify)
			r.Post("/auth/mfa/recover", mfaHandler.Recover)

			// Public catalog icon endpoint (for app icons)
			r.Get("/catalog/{appId}/icon", catalogHandler.GetAppIcon)

		})

		// CSRF-protected routes (authenticated users with CSRF tokens) - state-changing operations
		r.Group(func(r chi.Router) {
			r.Use(setupGuard)
			r.Use(middleware.Auth(authConfig))
			// CSRF protection on mutating routes
			r.Use(middleware.CSRF(authConfig.CSRFSecret))

			// Auth - authenticated user endpoints
			r.Post("/auth/logout", authHandler.Logout)
			r.Get("/auth/me", authHandler.Me)
			r.Put("/auth/profile", authHandler.UpdateProfile)
			r.Post("/auth/change-password", authHandler.ChangePassword)
			r.Get("/auth/csrf", csrfHandler.GetToken)

			// API tokens (programmatic access) — user-managed; session-authed + CSRF.
			r.Route("/api-tokens", func(r chi.Router) {
				r.Get("/", apiTokensHandler.List)
				r.Post("/", apiTokensHandler.Create)
				r.Delete("/{id}", apiTokensHandler.Revoke)
			})

			// MFA enrollment — session-authed + CSRF. (Login-flow endpoints are
			// public; see above.)
			r.Route("/auth/mfa", func(r chi.Router) {
				r.Get("/methods", mfaHandler.ListMethods)
				r.Post("/totp/setup", mfaHandler.SetupTOTP)
				r.Post("/totp/verify", mfaHandler.VerifyTOTP)
				r.Post("/email/setup", mfaHandler.SetupEmail)
				r.Post("/email/verify", mfaHandler.VerifyEmail)
				r.Post("/recovery-codes", mfaHandler.GenerateRecoveryCodes)
				r.Get("/recovery-codes", mfaHandler.RecoveryCodesRemaining)
				r.Delete("/methods/{id}", mfaHandler.DeleteMethod)
			})

			// Catalog - browse available apps
			r.Route("/catalog", func(r chi.Router) {
				r.Get("/", catalogHandler.ListApps)
				r.Get("/categories", catalogHandler.GetCategories)
				r.Post("/refresh", reposHandler.PullRepos)
				r.Get("/{appId}", catalogHandler.GetApp)
				r.Get("/{appId}/features", catalogHandler.GetAppFeatures)
			})

			// Repository management (admin only)
			r.Route("/repos", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Post("/pull", reposHandler.PullRepos)
				r.Get("/status", reposHandler.GetReposStatus)
				r.Post("/", reposHandler.AddRepo)
				r.Delete("/{index}", reposHandler.RemoveRepo)
			})

			scriptsHandler := handlers.NewScriptsHandler(s.appManager)
			logsHandler := handlers.NewLogsHandler(podman.NewRuntimeAdapter(s.runtimeClient))

			// Apps management - installed apps
			r.Route("/apps", func(r chi.Router) {
				r.Get("/", appsHandler.ListInstalledApps)
				r.Post("/", appsHandler.InstallApp)
				r.Get("/ports", appsHandler.ListAllocatedPorts)
				r.Get("/updates/history", appsHandler.GetUpdateHistory)
				r.Get("/updates/available", appsHandler.GetAvailableUpdates)
				r.Get("/{instanceId}", appsHandler.GetInstalledApp)
				r.Delete("/{instanceId}", appsHandler.UninstallApp)
				r.Get("/{instanceId}/status", appsHandler.GetAppStatus)
				r.Post("/{instanceId}/start", appsHandler.StartApp)
				r.Post("/{instanceId}/stop", appsHandler.StopApp)
				r.Post("/{instanceId}/restart", appsHandler.RestartApp)
				r.Post("/{instanceId}/acknowledge-revocation", appsHandler.AcknowledgeRevocation)
				r.Post("/{instanceId}/update", appsHandler.UpdateApp)
				r.Post("/{instanceId}/pin", appsHandler.PinAppVersion)
				r.Post("/{instanceId}/unpin", appsHandler.UnpinAppVersion)
				r.Get("/{instanceId}/updates/history", appsHandler.GetAppUpdateHistory)
				r.Get("/{instanceId}/exposed-info/{fieldName}", appsHandler.GetExposedInfoField)
				r.Get("/{instanceId}/actions", scriptsHandler.ListActions)
				r.Get("/{instanceId}/actions/{actionName}", scriptsHandler.GetAction)
				r.Post("/{instanceId}/actions/{actionName}/execute", scriptsHandler.ExecuteAction)
				r.Get("/{instanceId}/actions/{actionName}/stream", scriptsHandler.StreamAction)
				r.Get("/{instanceId}/install/stream", scriptsHandler.StreamInstall)
				r.Get("/{instanceId}/logs/stream", logsHandler.StreamLogs)
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
				r.Get("/config", settingsHandler.GetNotifications)
				r.Put("/config", settingsHandler.UpdateNotifications)
				r.Post("/preview", settingsHandler.PreviewTemplate)
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
				r.Use(middleware.RateLimit([]middleware.RateRule{
					{Prefix: "/api/v1/backups", Limit: 20, Window: time.Minute, ByUser: true},
				}))
				r.Get("/", backupHandler.ListBackups)
				r.Post("/", backupHandler.CreateBackup)
				r.Get("/capabilities", backupHandler.GetBackupCapabilities)
				r.Post("/provision", backupHandler.ProvisionBackupTool)
				r.Get("/{backupID}", backupHandler.GetBackup)
				r.Get("/{backupID}/download", backupHandler.DownloadBackup)
				r.Post("/{backupID}/restore", backupHandler.RestoreBackup)
				r.Delete("/{backupID}", backupHandler.DeleteBackup)

				// Backup schedules
				r.Get("/schedules", backupHandler.ListSchedules)
				r.Post("/schedules", backupHandler.CreateSchedule)
				r.Get("/schedules/{scheduleID}", backupHandler.GetSchedule)
				r.Put("/schedules/{scheduleID}", backupHandler.UpdateSchedule)
				r.Delete("/schedules/{scheduleID}", backupHandler.DeleteSchedule)

				// Backup repositories (restic)
				r.Get("/repos", backupHandler.ListRepositories)
				r.Post("/repos", backupHandler.CreateRepository)
				r.Delete("/repos/{repoID}", backupHandler.DeleteRepository)
				r.Post("/repos/test", backupHandler.TestRepository)

				// Database backups
				r.Get("/database", backupHandler.ListDatabaseBackups)
				r.Post("/database", backupHandler.CreateDatabaseBackup)
				r.Post("/database/upload-restore", backupHandler.UploadDatabaseBackup)
				r.Post("/database/{backupID}/restore", backupHandler.RestoreDatabaseBackup)

				// Backup repository stats
				r.Get("/repos/{repoID}/stats", backupHandler.GetRepoStats)
				r.Get("/repos/{repoID}/recovery-key", backupHandler.GetRepositoryRecoveryKey)
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
					r.Post("/domain/disconnect", networkHandler.DisconnectDomain)
					r.Get("/port-forwarding-status", networkHandler.GetPortForwardingStatus)
					r.Get("/upnp/status", networkHandler.GetUPnPStatus)
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
				r.Use(middleware.RateLimit([]middleware.RateRule{
					{Prefix: "/api/v1/support/sessions", Limit: 20, Window: time.Minute, ByUser: true},
				}))
				r.Get("/", supportHandler.ListSessions)
				r.Post("/", supportHandler.CreateSession)
				r.Get("/{sessionID}", supportHandler.GetSession)
				r.Post("/{sessionID}/revoke", supportHandler.RevokeSession)
			})

			// Support diagnostics - system diagnostics collection (admin only)
			r.Route("/support/diagnostics", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Use(middleware.RateLimit([]middleware.RateRule{
					{Prefix: "/api/v1/support/diagnostics", Limit: 10, Window: time.Minute, ByUser: true},
				}))
				r.Get("/", supportDiagHandler.Get)
			})

			// Support session validation - file and command execution (admin only)
			r.Route("/support/session", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Use(middleware.RateLimit([]middleware.RateRule{
					{Prefix: "/api/v1/support/session", Limit: 15, Window: time.Minute, ByUser: true},
				}))
				r.Post("/validate", supportSessionValidator.Validate)
				r.Post("/files/read", supportFileHandler.Read)
				r.Post("/files/write", supportFileHandler.Write)
				r.Post("/command", supportCommandHandler.Run)
			})

			// AI agent chat support (enabled in dev mode, or via LIBRESERV_AGENT_SUPPORT_ENABLED)
			if s.devMode || os.Getenv("LIBRESERV_INSECURE_DEV") == "true" || os.Getenv("LIBRESERV_AGENT_SUPPORT_ENABLED") == "true" {
				r.Route("/support/agent", func(r chi.Router) {
					r.Use(middleware.RateLimit([]middleware.RateRule{
						{Prefix: "/api/v1/support/agent", Limit: 30, Window: time.Minute, ByUser: true},
					}))

					// Conversation CRUD
					r.Get("/conversations", agentChatHandler.ListConversations)
					r.Post("/conversations", agentChatHandler.CreateConversation)
					r.Get("/conversations/{conversationID}", agentChatHandler.GetConversation)

					// Messaging
					r.Post("/conversations/{conversationID}/messages", agentChatHandler.SendMessage)

					// Permission flow
					r.Post("/conversations/{conversationID}/permission", agentChatHandler.RespondPermission)

					// Stop active agent
					r.Post("/conversations/{conversationID}/stop", agentChatHandler.StopConversation)

					// Audit trail
					r.Get("/conversations/{conversationID}/tool-calls", agentChatHandler.ListToolCalls)

					// Models and subscription
					r.Get("/models", agentChatHandler.GetModels)
					r.Get("/subscription", agentChatHandler.GetSubscription)
					r.Put("/subscription", agentChatHandler.UpdateSubscription)
				})
			}

			// Settings - unified application configuration
			r.Route("/settings", func(r chi.Router) {
				r.Get("/", settingsHandler.Get)

				// General settings update requires admin
				r.With(middleware.RequireRole("admin")).Put("/", settingsHandler.Update)

				// Proxy settings
				r.Get("/proxy", settingsHandler.GetProxy)
				r.With(middleware.RequireRole("admin")).Put("/proxy", settingsHandler.UpdateProxy)

				// Security settings - per-user notification preferences
				r.Get("/security", settingsHandler.GetSecurity)
				r.Put("/security", settingsHandler.UpdateSecurity)
				r.Post("/security/test", settingsHandler.TestNotification)

				// AI support settings (admin only for changes)
				r.Get("/ai-support", settingsHandler.GetAISupport)
				r.With(middleware.RequireRole("admin")).Put("/ai-support", settingsHandler.UpdateAISupport)
				r.With(middleware.RequireRole("admin")).Post("/ai-support/models", settingsHandler.FetchModels)
			})

			// System updates (admin only)
			r.Route("/system", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/updates/check", systemHandler.CheckUpdates)
				r.Post("/updates/apply", systemHandler.ApplyUpdate)
			})

			// DDNS auto-update service (admin only)
			r.Route("/network/ddns", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/status", ddnsHandler.GetStatus)
				r.Post("/update-now", ddnsHandler.ForceUpdate)
				r.Post("/interval", ddnsHandler.SetInterval)
			})

			// Network connectivity status (admin only)
			r.Route("/network/connectivity", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/", connectivityHandler.GetStatus)
			})

			// Connect — LibreServ Connect integration
			r.Route("/connect", func(r chi.Router) {
				r.Get("/status", connectHandler.Status)
				r.Put("/activate", connectHandler.Activate)
				r.Post("/deactivate", connectHandler.Deactivate)
				r.Put("/services", connectHandler.UpdateServices)
				r.Get("/usage", connectHandler.Usage)
				r.Get("/info", connectHandler.Info)
			})

			// Tunnel service (admin only)
			r.Route("/network/tunnel", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/status", tunnelHandler.GetStatus)
				r.Post("/enable", tunnelHandler.Enable)
				r.Post("/disable", tunnelHandler.Disable)
			})

			// Audit logs (admin only)
			r.Route("/audit", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Get("/", auditHandler.ListLogs)
			})

			// Factory reset (admin only - DANGEROUS!)
			r.Route("/admin", func(r chi.Router) {
				r.Use(middleware.RequireRole("admin"))
				r.Post("/factory-reset", factoryResetHandler.FactoryReset)
			})

			// Security monitoring (authenticated users)
			r.Route("/security", func(r chi.Router) {
				// Apply rate limiting: 60 requests per minute per user
				r.Use(middleware.RateLimit([]middleware.RateRule{
					{Prefix: "/api/v1/security", Limit: 60, Window: time.Minute},
				}))

				// Events - users can see their own events, admins see all
				r.Get("/events", securityHandler.ListEvents)

				// Stats - admin only
				r.With(middleware.RequireRole("admin")).Get("/stats", securityHandler.GetStats)

				// Health - check security service health and metrics (admin only)
				r.With(middleware.RequireRole("admin")).Get("/health", securityHandler.GetHealth)
			})
		})
	})

	// SSE stream endpoint for agent chat — must be outside auth middleware because
	// EventSource cannot send Authorization headers. Auth is handled internally
	// via cookie (withCredentials) or ?token= query param.
	if s.devMode || os.Getenv("LIBRESERV_INSECURE_DEV") == "true" || os.Getenv("LIBRESERV_AGENT_SUPPORT_ENABLED") == "true" {
		s.router.With(
			middleware.RateLimit([]middleware.RateRule{
				{Prefix: "/api/v1/support/agent", Limit: 30, Window: time.Minute},
			}),
		).Get("/api/v1/support/agent/conversations/{conversationID}/stream", agentChatHandler.StreamConversation)
	}

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
