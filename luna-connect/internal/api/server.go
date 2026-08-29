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
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/setuphub"
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
			DB: db, Store: objectStore, Tunnel: tunnel, DNS: dns, Hub: setuphub.New(),
		},
	}
	s.routes()
	return s
}

func (s *Server) Router() http.Handler { return s.router }

func (s *Server) routes() {
	r := chi.NewRouter()
	r.Use(handlers.SecurityHeaders)

	r.Get("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(200)
		_, _ = w.Write([]byte("ok"))
	})

	dev := handlers.DeviceHandler{Deps: s.deps}
	acct := handlers.AccountHandler{Deps: s.deps}
	bak := handlers.BackupHandler{Deps: s.deps}
	onb := handlers.OnboardingHandler{Deps: s.deps}
	adm := handlers.AdminAuthHandler{Deps: s.deps}
	console := handlers.AdminConsoleHandler{Deps: s.deps}

	r.Post("/api/v1/billing/webhook", http.MaxBytesHandler(http.HandlerFunc(acct.StripeWebhook), 65536).ServeHTTP)

	r.Group(func(r chi.Router) {
		r.Use(handlers.CSRF)
		r.Route("/api/v1", func(r chi.Router) {
			r.Group(func(r chi.Router) {
				r.Use(handlers.LimitJSONBody)
				r.Get("/config", acct.PublicConfig)
				r.Get("/domain/available", dev.Available)
				r.Post("/register", dev.Register)
				r.Post("/account/register", acct.Register)
				r.Post("/account/login", acct.Login)
				r.Get("/setup/ws", onb.SetupWS)

				r.Group(func(r chi.Router) {
					r.Use(acct.OptionalAccountAuth)
					r.Post("/onboarding/bind", onb.Bind)
					r.Get("/onboarding/session", onb.Session)
				})

				r.Group(func(r chi.Router) {
					r.Use(dev.DeviceAuth)
					r.Get("/status", dev.Status)
					r.Post("/domain", dev.Domain)
					r.Post("/first-user", dev.FirstUserUsed)
					r.Post("/unregister", dev.Unregister)
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
					r.Post("/backups/download", bak.Download)
					r.Delete("/backups", bak.DeleteAccountObject)
					r.Post("/onboarding/attach-account", onb.AttachAccount)
					r.Post("/onboarding/name", onb.Name)
					r.Post("/onboarding/backups", onb.Backups)
					r.Post("/account/verify-human", onb.VerifyHuman)
					r.Post("/account/oss-token", onb.MintOSS)
				})
			})

			r.Group(func(r chi.Router) {
				r.Use(dev.DeviceAuth)
				r.Put("/backup/objects/*", bak.PutObject)
			})
		})

		r.With(handlers.LimitJSONBody).Post("/admin/login", adm.Login)
		r.With(handlers.LimitJSONBody).Post("/admin/seed", adm.Seed)

		r.Group(func(r chi.Router) {
			r.Use(handlers.AdminAuth(s.db))
			r.Get("/admin/me", adm.Me)
			r.Post("/admin/logout", adm.Logout)
			r.With(handlers.LimitJSONBody).Post("/admin/2fa/setup", adm.Setup2FA)
			r.With(handlers.LimitJSONBody).Post("/admin/2fa/verify", adm.Verify2FA)
			r.With(handlers.LimitJSONBody).Post("/admin/password", adm.ChangePassword)
			r.Get("/admin/admins", adm.ListAdmins)
			r.With(handlers.LimitJSONBody).Post("/admin/admins", adm.CreateAdmin)
			r.Delete("/admin/admins/{adminID}", adm.DeleteAdmin)
			r.Get("/admin/stats", console.Stats)
			r.Get("/admin/devices", console.Devices)
			r.Get("/admin/accounts", console.Accounts)
			r.Get("/admin/setup-tokens", console.SetupTokens)
			r.Post("/admin/setup-tokens", onb.AdminMint)
			r.With(handlers.LimitJSONBody).Post("/admin/setup-tokens/bulk", onb.AdminMintBulk)
			r.Delete("/admin/setup-tokens/{tokenID}", console.RevokeSetupToken)
		})
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
