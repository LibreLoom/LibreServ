package api

import (
	"io/fs"
	"net/http"
	"strings"
)

// spaHandler serves embedded frontend assets with SPA fallback (index.html
// for unknown paths so client-side routing works). It does NOT intercept
// API routes — those are registered before the catch-all.
type spaHandler struct {
	fileServer http.Handler
	dist       fs.FS
}

func newSPAHandler(dist fs.FS) *spaHandler {
	return &spaHandler{
		fileServer: http.FileServer(http.FS(dist)),
		dist:       dist,
	}
}

func (h *spaHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	cleanPath := strings.TrimPrefix(r.URL.Path, "/")
	if cleanPath == "" {
		cleanPath = "index.html"
	}
	if _, err := fs.Stat(h.dist, cleanPath); err != nil {
		// SPA fallback — serve index.html for unknown paths
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/"
		h.fileServer.ServeHTTP(w, r2)
		return
	}
	// Set immutable cache for hashed assets
	if strings.HasPrefix(r.URL.Path, "/assets/") {
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	}
	h.fileServer.ServeHTTP(w, r)
}

// Path-based SPA selection: /admin/* serves the admin dashboard, everything
// else serves the customer portal. API routes (/admin/login, /admin/devices,
// etc.) are registered before this catch-all via chi.Route("/admin", ...),
// so they always take priority over the SPA handler.
//
// The admin SPA needs its assets served at /admin/assets/* and its router
// needs basename="/admin". The customer SPA is unaffected.
func (s *Server) spaMiddleware() http.HandlerFunc {
	adminFS := mustSubFS(embeddedAdmin, "admin/dist")
	customerFS := mustSubFS(embeddedCustomer, "customer/dist")

	adminSPA := newSPAHandler(adminFS)
	customerSPA := newSPAHandler(customerFS)

	return func(w http.ResponseWriter, r *http.Request) {
		// /admin/* → admin dashboard (SPA only, API routes already matched)
		if strings.HasPrefix(r.URL.Path, "/admin/") || r.URL.Path == "/admin" {
			// Strip /admin prefix for file serving, but keep it for the SPA router
			r2 := r.Clone(r.Context())
			r2.URL.Path = strings.TrimPrefix(r.URL.Path, "/admin")
			if r2.URL.Path == "" {
				r2.URL.Path = "/"
			}
			// Check if the stripped path exists in the admin dist
			cleanPath := strings.TrimPrefix(r2.URL.Path, "/")
			if cleanPath == "" {
				cleanPath = "index.html"
			}
			if _, err := fs.Stat(adminFS, cleanPath); err != nil {
				// SPA fallback
				r2.URL.Path = "/"
			}
			if strings.HasPrefix(r2.URL.Path, "/assets/") {
				w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			}
			adminSPA.fileServer.ServeHTTP(w, r2)
			return
		}
		customerSPA.ServeHTTP(w, r)
	}
}
