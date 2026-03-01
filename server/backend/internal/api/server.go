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
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/audit"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/backup/cloud"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobqueue"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/support"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/system"
)

// Server represents the HTTP API server
type Server struct {
	router          chi.Router
	httpServer      *http.Server
	addr            string
	db              *database.DB
	appManager      *apps.Manager
	authService     *auth.Service
	monitor         *monitoring.Monitor
	backupService   *storage.BackupService
	cloudService    *cloud.Service
	devMode         bool
	logger          *slog.Logger
	staticFS        fs.FS
	assetsHandler   http.Handler
	staticSource    string
	dockerClient    *docker.Client
	caddyManager    *network.CaddyManager
	setupService    *setup.Service
	supportService  *support.Service
	licenseService  middleware.LicenseChecker
	sysChecker      *system.UpdateChecker
	audit           *audit.Service
	securityService *security.Service
	jobQueue        JobQueue
}

// ServerConfig holds configuration for creating a new Server
type ServerConfig struct {
	Host           string
	Port           int
	DevMode        bool
	DB             *database.DB
	AppManager     *apps.Manager
	AuthService    *auth.Service
	Monitor        *monitoring.Monitor
	BackupService  *storage.BackupService
	CloudService   *cloud.Service
	DockerClient   *docker.Client
	CaddyManager   *network.CaddyManager
	SetupService   *setup.Service
	SupportService *support.Service
	LicenseService middleware.LicenseChecker
	SysChecker     *system.UpdateChecker
	AuditService   *audit.Service
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
	r.Use(chimiddleware.RealIP)
	r.Use(middleware.Logger(logger))
	r.Use(chimiddleware.Recoverer)
	r.Use(middleware.CORS(config.Get().CORS.AllowedOrigins))

	if cfg.DevMode {
		r.Use(middleware.DevSecurityHeaders())
	} else {
		r.Use(middleware.SecurityHeaders())
	}

	// Set request timeout
	r.Use(chimiddleware.Timeout(60 * time.Second))

	// Initialize security service with email notifier
	notifier := security.NewEmailNotifier()
	securityService := security.NewService(cfg.DB, logger, notifier)

	server := &Server{
		router:          r,
		addr:            addr,
		db:              cfg.DB,
		appManager:      cfg.AppManager,
		authService:     cfg.AuthService,
		monitor:         cfg.Monitor,
		backupService:   cfg.BackupService,
		cloudService:    cfg.CloudService,
		devMode:         cfg.DevMode,
		logger:          logger,
		dockerClient:    cfg.DockerClient,
		caddyManager:    cfg.CaddyManager,
		setupService:    cfg.SetupService,
		supportService:  cfg.SupportService,
		licenseService:  cfg.LicenseService,
		sysChecker:      cfg.SysChecker,
		audit:           cfg.AuditService,
		securityService: securityService,
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

	// Setup routes
	server.setupRoutes()

	return server
}

// Start starts the HTTP server
func (s *Server) Start() error {
	s.httpServer = &http.Server{
		Addr:         s.addr,
		Handler:      s.router,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	s.logger.Info("Starting HTTP server", "addr", s.addr)
	return s.httpServer.ListenAndServe()
}

// Shutdown gracefully shuts down the server
func (s *Server) Shutdown(ctx context.Context) error {
	s.logger.Info("Shutting down HTTP server")
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
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' https://gt.plainskill.net; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
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
