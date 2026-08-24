package api

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/audit"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/connect"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobqueue"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/podman"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/settings"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/system"
)

// Server represents the HTTP API server
// EmailSender sends MFA one-time codes + invite links to an email address. nil
// receivers are safe to skip; a nil EmailSender disables email MFA + invites.
type EmailSender interface {
	SendOTP(email, code string) error
	SendInvite(email, inviteURL string) error
}

// mfaEmailSender adapts a server.EmailSender to the func(email, code) error
// signature that handlers.NewMFAHandler expects. nil -> email MFA disabled.
func mfaEmailSender(s EmailSender) func(email, code string) error {
	if s == nil {
		return nil
	}
	return func(email, code string) error { return s.SendOTP(email, code) }
}

// SetEmailSender rewires the email-OTP and invite senders at runtime — e.g.
// after Connect provisioning writes smtp.* settings, so email MFA and invites
// become available without a restart. nil disables both again.
func (s *Server) SetEmailSender(sender EmailSender) {
	s.emailSender = sender
	if s.mfaHandler != nil {
		s.mfaHandler.SetEmailSender(mfaEmailSender(sender))
	}
	if s.inviteHandler != nil {
		s.inviteHandler.SetSender(inviteSender(sender, s.inviteBase))
	}
}

// inviteSender adapts a server.EmailSender to the func(email, token) error
// signature that handlers.NewInviteHandler expects, building the invite URL
// from baseURL. nil sender -> nil func (invites disabled).
func inviteSender(s EmailSender, baseURL string) func(email, token string) error {
	if s == nil {
		return nil
	}
	return func(email, token string) error {
		return s.SendInvite(email, baseURL+"/invite/"+token)
	}
}

// Server holds runtime state for the API server.
type Server struct {
	router          chi.Router
	httpServer      *http.Server
	addr            string
	db              *database.DB
	appManager      *apps.Manager
	authService     *auth.Service
	monitor         *monitoring.Monitor
	backupService   *storage.BackupService
	devMode         bool
	logger          *slog.Logger
	staticFS        fs.FS
	assetsHandler   http.Handler
	staticSource    string
	runtimeClient   *podman.Client
	caddyManager    *network.CaddyManager
	setupService    *setup.Service
	sysChecker      *system.UpdateChecker
	audit           *audit.Service
	securityService *security.Service
	settingsService *settings.Service
	jobQueue        JobQueue
	dnsProviderMgr  *network.DNSProviderManager
	acmeManager     *network.ACMEManager
	ddnsService     *network.DDNSService
	tunnelService   *network.TunnelService
	reportService   *network.ReportService
	pathStateStore  *network.PathStateStore
	upnpClient      *network.UPnPClient
	// agentChat removed — field was unused
	selfHealMonitor  *agent.SelfHealingMonitor
	connectClient    connect.Client
	connectChecker   *connect.EntitlementChecker
	emailSender      EmailSender          // sends MFA email-OTP codes; nil disables email MFA
	mfaHandler       *handlers.MFAHandler // rewired by SetEmailSender when SMTP settings change
	inviteHandler    *handlers.InviteHandler
	inviteBase       string
	oidcHandler      http.Handler          // OIDC provider endpoints (discovery, authorize, token, userinfo)
	oidcAdminHandler *handlers.OIDCHandler // admin API for managing OIDC clients per app
}

// ServerConfig holds configuration for creating a new Server
type ServerConfig struct {
	Host             string
	Port             int
	DevMode          bool
	DB               *database.DB
	AppManager       *apps.Manager
	AuthService      *auth.Service
	Monitor          *monitoring.Monitor
	BackupService    *storage.BackupService
	RuntimeClient    *podman.Client
	CaddyManager     *network.CaddyManager
	ACMEManager      *network.ACMEManager
	SetupService     *setup.Service
	SysChecker       *system.UpdateChecker
	AuditService     *audit.Service
	SettingsService  *settings.Service
	ConnectClient    connect.Client
	ConnectChecker   *connect.EntitlementChecker
	EmailSender      EmailSender
	OIDCHandler      http.Handler
	OIDCAdminHandler *handlers.OIDCHandler
}

// JobQueue interface for job queue operations
type JobQueue interface {
	Enqueue(jobType jobqueue.JobType, domain, email, routeID string, priority jobqueue.JobPriority) (jobqueue.JobInfo, error)
	GetJob(ctx context.Context, jobID string) (jobqueue.JobInfo, error)
	GetLatestJob(ctx context.Context, domain string, jobType jobqueue.JobType) (jobqueue.JobInfo, error)
	GetJobsByStatus(status jobqueue.JobStatus, limit int) ([]*jobqueue.Job, error)
	GetPendingJobs(limit int) ([]*jobqueue.Job, error)
	GetRunningJobs() ([]*jobqueue.Job, error)
	GetQueueStats() (*jobqueue.QueueStats, error)
	CancelJob(jobID string) error
	IsRunning() bool
}

// NewServer creates a new API server instance from config
func NewServer(cfg ServerConfig) *Server {
	addr := fmt.Sprintf("%s:%d", cfg.Host, cfg.Port)
	logger := slog.Default().With("component", "api")

	r := chi.NewRouter()

	// Global middleware stack
	r.Use(chimiddleware.RequestID)
	r.Use(middleware.RealIP())
	r.Use(middleware.Logger(logger))
	r.Use(chimiddleware.Recoverer)
	corsOrigins := config.Get().CORS.AllowedOrigins
	corsDevMode := cfg.DevMode || os.Getenv("LIBRESERV_INSECURE_DEV") == "true"
	if corsDevMode && len(corsOrigins) == 0 {
		corsOrigins = []string{"http://localhost:3000", "http://localhost:5173", "http://127.0.0.1:3000", "http://127.0.0.1:5173"}
	}
	r.Use(middleware.CORS(corsOrigins, corsDevMode))

	if cfg.DevMode {
		r.Use(middleware.DevSecurityHeaders())
	} else {
		r.Use(middleware.SecurityHeaders())
	}

	r.Use(maxBodySize(10 << 20))

	if cfg.DevMode {
		cfg := config.Get()
		if cfg != nil && cfg.Server.Mode == "production" {
			logger.Error("DEV MODE IS ACTIVE IN PRODUCTION CONFIG - security headers are relaxed")
		} else {
			logger.Warn("dev mode is enabled - security headers are relaxed")
		}
	}

	r.Use(chimiddleware.Timeout(60 * time.Second))

	// Initialize security service with email notifier
	notifier := security.NewEmailNotifier()
	securityService := security.NewService(cfg.DB, logger, notifier)

	server := &Server{
		router:           r,
		addr:             addr,
		db:               cfg.DB,
		appManager:       cfg.AppManager,
		authService:      cfg.AuthService,
		monitor:          cfg.Monitor,
		backupService:    cfg.BackupService,
		devMode:          cfg.DevMode,
		logger:           logger,
		runtimeClient:    cfg.RuntimeClient,
		caddyManager:     cfg.CaddyManager,
		acmeManager:      cfg.ACMEManager,
		setupService:     cfg.SetupService,
		sysChecker:       cfg.SysChecker,
		audit:            cfg.AuditService,
		securityService:  securityService,
		settingsService:  cfg.SettingsService,
		connectClient:    cfg.ConnectClient,
		connectChecker:   cfg.ConnectChecker,
		emailSender:      cfg.EmailSender,
		oidcHandler:      cfg.OIDCHandler,
		oidcAdminHandler: cfg.OIDCAdminHandler,
	}

	staticFS, staticSource, err := loadStaticFS()
	if err != nil {
		logger.Warn("Static asset source unavailable", "source", staticSource, "error", err)
	}
	if staticFS == nil {
		staticFS = os.DirFS(".")
		staticSource = "fallback"
	}
	server.staticFS = staticFS
	server.staticSource = staticSource
	server.assetsHandler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assetPath := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if !strings.HasPrefix(assetPath, "assets/") {
			http.NotFound(w, r)
			return
		}
		assetPath = strings.TrimPrefix(assetPath, "assets/")
		if assetPath == "" || assetPath == "." || assetPath == "/" {
			http.NotFound(w, r)
			return
		}
		server.serveStaticPath(w, r, path.Join("assets", assetPath))
	})
	if _, err := fs.Sub(staticFS, "assets"); err != nil {
		logger.Warn("Static assets directory missing", "source", staticSource, "error", err)
	}

	// Initialize the DNS provider manager before anything that consumes it.
	// The DDNS loop calls into it on a timer, so it must be non-nil here;
	// setupRoutes() (which also references it) reuses this same instance.
	server.dnsProviderMgr = network.NewDNSProviderManager(cfg.DB)

	// Initialize DDNS auto-update service
	server.ddnsService = network.NewDDNSService(cfg.DB, server.dnsProviderMgr, cfg.AuditService)

	// Initialize tunnel service
	tunnelCfg := network.TunnelConfig{
		Providers: map[network.TunnelProviderType]network.TunnelProviderConfig{
			network.TunnelProviderType(config.Get().Network.Tunnel.Provider): {
				Token:   config.Get().Network.Tunnel.Token,
				Enabled: config.Get().Network.Tunnel.Enabled,
			},
		},
	}
	server.tunnelService = network.NewTunnelService(tunnelCfg, filepath.Join(config.Get().Apps.DataPath, "bin"))

	// Initialize network report service (15-min loop; reads DDNS IP state,
	// never races it for DNS updates).
	upnpLogger := slog.Default().With("component", "upnp")
	reportLogger := slog.Default().With("component", "network-report")
	server.pathStateStore = network.NewPathStateStore(cfg.DB)
	server.upnpClient = network.NewUPnPClient(upnpLogger)

	// The verify loop's outside prober: Connect's verify-probe endpoint.
	// The device cannot verify its own reachability — Connect's edge can.
	var verifier network.Verifier
	if server.connectClient != nil {
		verifier = &network.ConnectVerifier{
			Probe: func(ctx context.Context, host string, port int, protocol string) (bool, error) {
				res, err := server.connectClient.VerifyProbe(ctx, host, port, protocol)
				if err != nil {
					return false, err
				}
				return res.Reachable, nil
			},
		}
	}

	server.reportService = network.NewReportService(
		server.upnpClient,
		server.ddnsService,
		func() network.ReportInputs {
			inputs := network.ReportInputs{
				Connect: network.ConnectState{
					Active: server.connectClient != nil && server.connectChecker != nil,
				},
				Domain: network.DomainState{Source: "none"},
			}
			// Real domain state: the configured DNS provider's domain.
			if server.dnsProviderMgr != nil {
				if cfg, err := server.dnsProviderMgr.GetConfig(context.Background()); err == nil && cfg != nil && cfg.Domain != "" {
					inputs.Domain = network.DomainState{Source: "own", Name: cfg.Domain}
				}
			}
			// Real tunnel state: the tunnel service's status.
			if server.tunnelService != nil {
				ts := server.tunnelService.GetStatus()
				if ts.Enabled && ts.URL != "" {
					inputs.Connect.TunnelOK = true
				}
			}
			return inputs
		},
		reportLogger,
		verifier,
		server.pathStateStore,
	)

	// Regenerate the report immediately when DDNS detects an IP change
	// (the report loop would otherwise serve a stale report for up to 15 min).
	if server.ddnsService != nil && server.reportService != nil {
		server.ddnsService.OnIPChange(func() {
			server.reportService.Regenerate(context.Background())
		})
	}

	// Initialize self-healing monitor
	server.selfHealMonitor = agent.NewSelfHealingMonitor(cfg.RuntimeClient, cfg.DB, server.connectClient, server.connectChecker)

	// Setup routes
	server.setupRoutes()

	// Start DDNS service if enabled
	server.ddnsService.Start()

	// Start network report service (reads DDNS state; generate an initial report)
	if server.reportService != nil {
		server.reportService.Start(context.Background())
	}

	// Start tunnel service if enabled
	if server.tunnelService != nil {
		if err := server.tunnelService.Start(context.Background()); err != nil {
			logger.Warn("Failed to start tunnel service", "error", err)
		}
	}

	// Start self-healing monitor if enabled
	server.selfHealMonitor.Start()

	return server
}

// Start starts the HTTP server
func (s *Server) Start() error {
	var readTimeout, writeTimeout, idleTimeout time.Duration
	if s.devMode {
		readTimeout = 30 * time.Second
		writeTimeout = 120 * time.Second
		idleTimeout = 120 * time.Second
	} else {
		readTimeout = 15 * time.Second
		writeTimeout = 15 * time.Second
		idleTimeout = 60 * time.Second
	}
	s.httpServer = &http.Server{
		Addr:           s.addr,
		Handler:        s.router,
		ReadTimeout:    readTimeout,
		WriteTimeout:   writeTimeout,
		IdleTimeout:    idleTimeout,
		MaxHeaderBytes: 1 << 20,
	}

	s.logger.Info("Starting HTTP server", "addr", s.addr)
	return s.httpServer.ListenAndServe()
}

// Shutdown gracefully shuts down the server
func (s *Server) Shutdown(ctx context.Context) error {
	s.logger.Info("Shutting down HTTP server")
	if s.ddnsService != nil {
		s.ddnsService.Stop()
	}
	if s.reportService != nil {
		s.reportService.Stop()
	}
	if s.tunnelService != nil {
		s.tunnelService.Stop()
	}
	if s.selfHealMonitor != nil {
		s.selfHealMonitor.Stop()
	}
	middleware.StopRateLimiters()
	return s.httpServer.Shutdown(ctx)
}

// Router returns the chi router (useful for testing)
func (s *Server) Router() chi.Router {
	return s.router
}

// WithJobQueue sets the job queue for the server
func (s *Server) WithJobQueue(queue JobQueue) *Server {
	s.jobQueue = queue
	return s
}

// Log implements handlers.AuditLogger
func (s *Server) Log(ctx context.Context, action, targetID, targetName, status, message string, metadata map[string]interface{}) {
	s.auditLog(ctx, action, targetID, targetName, status, message, metadata)
}

// auditLog is a helper to record an audit entry
func (s *Server) auditLog(ctx context.Context, action, targetID, targetName, status, message string, metadata map[string]interface{}) {
	if s.audit == nil {
		return
	}
	// Get current user from context (populated by auth middleware)
	actorID := ""
	actorUsername := "system"
	if user := middleware.GetUser(ctx); user != nil {
		actorID = user.ID
		actorUsername = user.Username
	}

	entry := audit.Entry{
		ActorID:       actorID,
		ActorUsername: actorUsername,
		Action:        action,
		TargetID:      targetID,
		TargetName:    targetName,
		Status:        status,
		Message:       message,
		Metadata:      metadata,
		Timestamp:     time.Now(),
	}

	s.audit.Record(ctx, entry)
}

// serveSPA serves static assets from the web/dist directory with index.html fallback for SPA routes
func (s *Server) serveSPA(w http.ResponseWriter, r *http.Request) {
	s.logger.Debug("SPA handler", "path", r.URL.Path, "static_source", s.staticSource)
	// Prevent directory traversal
	path := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
	if path == "" || path == "." {
		path = "index.html"
	}

	// If the file does not exist, serve index.html for client-side routing.
	if _, err := fs.Stat(s.staticFS, path); err != nil {
		path = "index.html"
	}

	s.serveStaticPath(w, r, path)
}

// resolveStaticDir returns an absolute path to the built frontend assets
func resolveStaticDir() string {
	abs, err := filepath.Abs("./OS/dist")
	if err != nil {
		return "./OS/dist"
	}
	return abs
}

func (s *Server) serveStaticPath(w http.ResponseWriter, r *http.Request, path string) {
	// Content-hashed Vite assets never change: cache hard. index.html must be
	// revalidated on every load so browsers pick up new deploys immediately.
	// Everything else (public fonts, etc.) gets a moderate lifetime.
	if strings.HasPrefix(path, "assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	} else if path == "index.html" {
		w.Header().Set("Cache-Control", "no-cache")
	} else {
		w.Header().Set("Cache-Control", "public, max-age=3600")
	}

	if acceptsGzip(r) {
		gzPath := path + ".gz"
		if _, err := fs.Stat(s.staticFS, gzPath); err == nil {
			addVaryHeader(w.Header(), "Accept-Encoding")
			w.Header().Set("Content-Encoding", "gzip")
			s.serveFSPath(w, r, gzPath, path)
			return
		}
	}

	s.serveFSPath(w, r, path, path)
}

func (s *Server) serveFSPath(w http.ResponseWriter, r *http.Request, fsPath, name string) {
	file, err := s.staticFS.Open(fsPath)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer func() {
		if cerr := file.Close(); cerr != nil {
			s.logger.Warn("failed to close file", "error", cerr)
		}
	}()

	info, err := file.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}

	reader, ok := file.(io.ReadSeeker)
	if !ok {
		data, err := io.ReadAll(file)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		reader = bytes.NewReader(data)
	}

	// Set Content Security Policy headers for XSS protection
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'sha256-IEhI62YIJjWGgJ2eGBaEs/pLhpzi3D0Om6s+T2cMIKI='; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://gt.plainskill.net; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")

	http.ServeContent(w, r, name, info.ModTime(), reader)
}

func acceptsGzip(r *http.Request) bool {
	return strings.Contains(r.Header.Get("Accept-Encoding"), "gzip")
}

func addVaryHeader(header http.Header, value string) {
	if existing := header.Get("Vary"); existing != "" {
		header.Set("Vary", existing+", "+value)
		return
	}
	header.Set("Vary", value)
}

func maxBodySize(max int64) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			r.Body = http.MaxBytesReader(w, r.Body, max)
			next.ServeHTTP(w, r)
		})
	}
}
