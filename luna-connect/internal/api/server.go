package api

import (
	"database/sql"
	"io"
	"net/http"
	"os"
	"path"
	"strings"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/api/handlers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

type Server struct {
	db     *sql.DB
	router *chi.Mux
	deps   handlers.Deps
}

func NewServer(db *sql.DB, objectStore store.Store) *Server {
	tunnel := providers.NewTunnelClient()
	dns := providers.NewDNSClient()
	if !config.C.Cloudflare.Ready() {
		tunnel.MockMode = true
		dns.MockMode = true
	}
	s := &Server{
		db: db,
		deps: handlers.Deps{
			DB: db, Store: objectStore, Tunnel: tunnel, DNS: dns,
		},
	}
	s.routes()
	return s
}

func (s *Server) Router() http.Handler { return s.router }

func (s *Server) routes() {
	r := chi.NewRouter()
	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok"))
	})

	dev := handlers.DeviceHandler{Deps: s.deps}
	acct := handlers.AccountHandler{Deps: s.deps}
	bak := handlers.BackupHandler{Deps: s.deps}

	r.Route("/api/v1", func(r chi.Router) {
		r.Get("/domain/available", dev.Available)
		r.Post("/register", dev.Register)
		r.Post("/account/register", acct.Register)
		r.Post("/account/login", acct.Login)

		r.Group(func(r chi.Router) {
			r.Use(dev.DeviceAuth)
			r.Get("/status", dev.Status)
			r.Post("/domain", dev.Domain)
			r.Post("/unregister", dev.Unregister)
			r.Post("/pairing-code", dev.PairingCode)
			r.Put("/backup/objects/*", bak.PutObject)
			r.Delete("/backup/objects/*", bak.DeleteObject)
		})

		r.Group(func(r chi.Router) {
			r.Use(acct.AccountAuth)
			r.Get("/account/me", acct.Me)
			r.Post("/account/logout", acct.Logout)
			r.Get("/billing/usage", acct.Usage)
			r.Post("/billing/attach-card", acct.AttachCard)
			r.Post("/account/pair", acct.Pair)
			r.Get("/account/devices", acct.Devices)
			r.Get("/backups", bak.List)
			r.Get("/backups/download", bak.Download)
			r.Delete("/backups", bak.DeleteAccountObject)
		})
	})

	r.Get("/admin/devices", func(w http.ResponseWriter, r *http.Request) {
		if config.C.Server.AdminToken == "" || r.Header.Get("Authorization") != "Bearer "+config.C.Server.AdminToken {
			handlers.JSONError(w, http.StatusUnauthorized, "Admin sign-in required.")
			return
		}
		rows, err := s.db.Query(`SELECT id, subdomain, name FROM devices`)
		if err != nil {
			handlers.JSONError(w, http.StatusInternalServerError, "Could not list devices.")
			return
		}
		defer rows.Close()
		var list []map[string]string
		for rows.Next() {
			var id, sub, name string
			_ = rows.Scan(&id, &sub, &name)
			list = append(list, map[string]string{"id": id, "hostname": sub + "." + config.C.Server.PublicZone, "name": name})
		}
		handlers.JSON(w, 200, map[string]any{"devices": list})
	})

	s.mountWeb(r)
	s.router = r
}

func (s *Server) mountWeb(r *chi.Mux) {
	dir := config.C.Server.WebDir
	if dir == "" {
		dir = "web/dist"
	}
	if _, err := os.Stat(dir); err != nil {
		return
	}
	fs := http.FileServer(http.Dir(dir))
	r.Get("/*", func(w http.ResponseWriter, req *http.Request) {
		if strings.HasPrefix(req.URL.Path, "/api/") {
			http.NotFound(w, req)
			return
		}
		p := path.Join(dir, path.Clean(req.URL.Path))
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			fs.ServeHTTP(w, req)
			return
		}
		f, err := os.Open(path.Join(dir, "index.html"))
		if err != nil {
			http.NotFound(w, req)
			return
		}
		defer f.Close()
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = io.Copy(w, f)
	})
}
