package api

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// Server represents the HTTP API server
type Server struct {
	router     chi.Router
	httpServer *http.Server
	addr       string
	db         *database.DB
	logger     *slog.Logger
}

// NewServer creates a new API server instance
func NewServer(host string, port int, db *database.DB) *Server {
	addr := fmt.Sprintf("%s:%d", host, port)
	logger := slog.Default().With("component", "api")

	r := chi.NewRouter()

	// Global middleware stack
	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.RealIP)
	r.Use(middleware.Logger(logger))
	r.Use(chimiddleware.Recoverer)
	r.Use(middleware.CORS())

	// Set request timeout
	r.Use(chimiddleware.Timeout(60 * time.Second))

	server := &Server{
		router: r,
		addr:   addr,
		db:     db,
		logger: logger,
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
