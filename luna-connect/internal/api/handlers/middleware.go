package handlers

import (
	"crypto/subtle"
	"net/http"
	"net/url"
	"strings"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

const (
	csrfCookieName = "luna_connect_csrf"
	jsonBodyLimit  = 1 << 20
	webhookLimit   = 65536
)

func SecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "geolocation=(), microphone=(), camera=()")
		w.Header().Set("Content-Security-Policy", strings.Join([]string{
			"default-src 'self'",
			"script-src 'self' https://js.stripe.com https://static.cloudflareinsights.com",
			"style-src 'self' 'unsafe-inline'",
			"img-src 'self' data: blob:",
			"font-src 'self' data:",
			"connect-src 'self' https://api.stripe.com https://js.stripe.com https://cloudflareinsights.com https://*.cloudflareinsights.com",
			"frame-src https://js.stripe.com https://hooks.stripe.com",
			"frame-ancestors 'none'",
			"base-uri 'self'",
			"form-action 'self'",
		}, "; "))
		if config.CookieSecure() {
			w.Header().Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

func LimitJSONBody(next http.Handler) http.Handler {
	return http.MaxBytesHandler(next, jsonBodyLimit)
}

func CSRF(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			ensureCSRFCookie(w, r)
			next.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			next.ServeHTTP(w, r)
			return
		}
		if r.URL.Path == "/api/v1/billing/webhook" {
			next.ServeHTTP(w, r)
			return
		}
		c, err := r.Cookie(csrfCookieName)
		got := r.Header.Get("X-CSRF-Token")
		if got == "" {
			_ = r.ParseForm()
			got = r.FormValue("csrf_token")
		}
		if err != nil || c.Value == "" || got == "" || subtle.ConstantTimeCompare([]byte(c.Value), []byte(got)) != 1 {
			JSONError(w, http.StatusForbidden, "This page expired. Refresh and try again.")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func ensureCSRFCookie(w http.ResponseWriter, r *http.Request) string {
	if c, err := r.Cookie(csrfCookieName); err == nil && c.Value != "" {
		return c.Value
	}
	tok := security.RandomHex(16)
	http.SetCookie(w, &http.Cookie{
		Name:     csrfCookieName,
		Value:    tok,
		Path:     "/",
		HttpOnly: false,
		Secure:   config.CookieSecure(),
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(SessionTTL.Seconds()),
	})
	return tok
}

func originAllowed(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	base := strings.TrimRight(strings.TrimSpace(config.C.Server.BaseURL), "/")
	if base != "" && strings.EqualFold(origin, base) {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return false
	}
	bu, err := url.Parse(base)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Scheme, bu.Scheme) && strings.EqualFold(u.Host, bu.Host)
}
