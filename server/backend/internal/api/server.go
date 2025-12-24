package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/audit"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/support"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/system"
)

// Server represents the HTTP API server
type Server struct {
	router         chi.Router
	httpServer     *http.Server
	addr           string
	db             *database.DB
	appManager     *apps.Manager
	authService    *auth.Service
	monitor        *monitoring.Monitor
	backupService  *storage.BackupService
	devMode        bool
	logger         *slog.Logger
	staticDir      string
	dockerClient   *docker.Client
	caddyManager   *network.CaddyManager
	setupService   *setup.Service
	supportService *support.Service
	licenseService middleware.LicenseChecker
	sysChecker     *system.UpdateChecker
	audit          *audit.Service
}

// NewServer creates a new API server instance
func NewServer(host string, port int, db *database.DB, appManager *apps.Manager, authService *auth.Service, monitor *monitoring.Monitor, backupService *storage.BackupService, dockerClient *docker.Client, caddyManager *network.CaddyManager, setupService *setup.Service, supportService *support.Service, licenseService middleware.LicenseChecker, sysChecker *system.UpdateChecker, auditSvc *audit.Service, devMode bool) *Server {
	addr := fmt.Sprintf("%s:%d", host, port)
	logger := slog.Default().With("component", "api")

	r := chi.NewRouter()

	// Global middleware stack
	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.RealIP)
	r.Use(middleware.Logger(logger))
	r.Use(chimiddleware.Recoverer)
	r.Use(middleware.CORS(config.Get().CORS.AllowedOrigins))

	// Set request timeout
	r.Use(chimiddleware.Timeout(60 * time.Second))

	server := &Server{
		router:         r,
		addr:           addr,
		db:             db,
		appManager:     appManager,
		authService:    authService,
		monitor:        monitor,
		backupService:  backupService,
		devMode:        devMode,
		logger:         logger,
		staticDir:      resolveStaticDir(),
		dockerClient:   dockerClient,
		caddyManager:   caddyManager,
		setupService:   setupService,
		supportService: supportService,
		licenseService: licenseService,
		sysChecker:     sysChecker,
		audit:          auditSvc,
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
	s.logger.Debug("SPA handler", "path", r.URL.Path, "static_dir", s.staticDir)
	// Prevent directory traversal
	path := strings.TrimPrefix(filepath.Clean(r.URL.Path), "/")
	if path == "" || path == "." {
		path = "index.html"
	}

	staticPath := filepath.Join(s.staticDir, path)

	// If the file does not exist, serve index.html for client-side routing
	if _, err := os.Stat(staticPath); err != nil {
		http.ServeFile(w, r, filepath.Join(s.staticDir, "index.html"))
		return
	}

	http.ServeFile(w, r, staticPath)
}

// resolveStaticDir returns an absolute path to the built frontend assets
func resolveStaticDir() string {
	abs, err := filepath.Abs("./OS/dist")
	if err != nil {
		return "./OS/dist"
	}
	return abs
}
