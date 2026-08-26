package middleware

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
)

const portalSessionCookie = "connect_portal_session"

// SetPortalSessionCookie writes the portal session token as an HttpOnly cookie
// with SameSite=Lax and Secure when the configured base URL is HTTPS.
func SetPortalSessionCookie(w http.ResponseWriter, token string) {
	ttl := config.C.Auth.SessionTTLHours
	if ttl == 0 {
		ttl = 168
	}
	http.SetCookie(w, &http.Cookie{
		Name:     portalSessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   config.CookieSecure(),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   ttl * 3600,
		Expires:  time.Now().Add(time.Duration(ttl) * time.Hour),
	})
}

// ClearPortalSessionCookie expires the portal session cookie.
func ClearPortalSessionCookie(w http.ResponseWriter) {
	http.SetCookie(w, &http.Cookie{
		Name:     portalSessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   config.CookieSecure(),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
		Expires:  time.Unix(0, 0),
	})
}

// portalSessionToken returns the portal session token from the request cookie.
func portalSessionToken(r *http.Request) string {
	c, err := r.Cookie(portalSessionCookie)
	if err != nil || c.Value == "" {
		return ""
	}
	return c.Value
}

// OriginAllowed reports whether the request Origin is empty (non-browser or
// legacy clients) or matches the configured portal base URL / request host.
// Used as a CSRF defense for cookie-authenticated portal writes.
func OriginAllowed(r *http.Request) bool {
	origin := strings.TrimSpace(r.Header.Get("Origin"))
	if origin == "" {
		return true
	}
	base := strings.TrimRight(strings.TrimSpace(config.C.Server.BaseURL), "/")
	if base != "" {
		if strings.EqualFold(origin, base) {
			return true
		}
		ou, err := url.Parse(origin)
		if err != nil || ou.Scheme == "" || ou.Host == "" {
			return false
		}
		bu, err := url.Parse(base)
		if err != nil || bu.Scheme == "" || bu.Host == "" {
			return false
		}
		return strings.EqualFold(ou.Scheme, bu.Scheme) && strings.EqualFold(ou.Host, bu.Host)
	}
	// No base URL configured: require Origin to match this request's host.
	ou, err := url.Parse(origin)
	if err != nil || ou.Host == "" {
		return false
	}
	return strings.EqualFold(ou.Host, r.Host)
}

// PortalOriginCheck rejects mutating portal requests whose Origin is set and
// does not match the portal. Bearer-authenticated requests skip the check
// (Authorization header is not sent by cross-site form posts).
func PortalOriginCheck(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet, http.MethodHead, http.MethodOptions:
			next.ServeHTTP(w, r)
			return
		}
		if strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") {
			next.ServeHTTP(w, r)
			return
		}
		if !OriginAllowed(r) {
			http.Error(w, `{"error":"origin not allowed"}`, http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

type bufWriter struct {
	http.ResponseWriter
	code int
	buf  bytes.Buffer
	hdr  http.Header
}

func (w *bufWriter) Header() http.Header {
	if w.hdr == nil {
		w.hdr = make(http.Header)
	}
	return w.hdr
}

func (w *bufWriter) WriteHeader(code int) { w.code = code }

func (w *bufWriter) Write(p []byte) (int, error) {
	if w.code == 0 {
		w.code = http.StatusOK
	}
	return w.buf.Write(p)
}

// AttachPortalSessionCookie copies a successful login/register JSON token into
// the HttpOnly portal session cookie so the SPA can keep using bearer JSON
// while browsers also get a cookie-backed session.
func AttachPortalSessionCookie(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		bw := &bufWriter{ResponseWriter: w}
		next.ServeHTTP(bw, r)
		code := bw.code
		if code == 0 {
			code = http.StatusOK
		}
		if code >= 200 && code < 300 {
			var body struct {
				Token string `json:"token"`
			}
			if json.Unmarshal(bw.buf.Bytes(), &body) == nil && body.Token != "" {
				SetPortalSessionCookie(w, body.Token)
			}
		}
		dst := w.Header()
		for k, vs := range bw.hdr {
			dst[k] = vs
		}
		w.WriteHeader(code)
		_, _ = w.Write(bw.buf.Bytes())
	})
}

// PortalLogout expires the portal session cookie.
func PortalLogout(w http.ResponseWriter, r *http.Request) {
	ClearPortalSessionCookie(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write([]byte(`{"ok":true}`))
}
