package handlers

import (
	"context"
	"database/sql"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"net"
	"net/http"
	"strings"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/mail"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

type ctxKey string

const (
	deviceKey  ctxKey = "device"
	accountKey ctxKey = "account"
)

// MaxDevicesPerAccount caps how many Lunas one account may bind.
// Schema supports many; the product UI is built for one.
const MaxDevicesPerAccount = 1

// OnlineWithinSec is how recent last_seen_at must be for "Online" (2× 5m refresh).
const OnlineWithinSec = 10 * 60

type Device struct {
	ID         string
	AccountID  sql.NullString
	Subdomain  string
	TunnelID   string
	Name       string
	CodeHash   string
	Kind       string
	LastSeenAt sql.NullInt64
	Revoked    bool
}

type Account struct {
	ID               string
	Email            string
	HasCard          bool
	BillingStatus    string
	StripeCustomer   string
	StripeSub        string
	BackupPurgeAfter int64
	EmailVerified    bool
	OnboardingPath   string
	OnboardingStep   string
}

func WithDevice(ctx context.Context, d Device) context.Context {
	return context.WithValue(ctx, deviceKey, d)
}

func DeviceFrom(ctx context.Context) (Device, bool) {
	d, ok := ctx.Value(deviceKey).(Device)
	return d, ok
}

func WithAccount(ctx context.Context, a Account) context.Context {
	return context.WithValue(ctx, accountKey, a)
}

func AccountFrom(ctx context.Context) (Account, bool) {
	a, ok := ctx.Value(accountKey).(Account)
	return a, ok
}

type Deps struct {
	DB     *database.DB
	Store  store.Store
	Tunnel providers.Tunnel
	DNS    providers.DNS
	Mail   mail.Sender
}

func ClientIP(r *http.Request) string {
	remote := remoteHost(r.RemoteAddr)
	if trustedProxy(remote) {
		// Cloudflare sets this to the real client; Caddy on loopback passes it through.
		// Prefer it over XFF so we do not bucket everyone on the edge/proxy IP.
		if cf := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); cf != "" {
			return stripPort(cf)
		}
		if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
			return stripPort(xri)
		}
		if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[0]); ip != "" {
				return stripPort(ip)
			}
		}
	}
	if remote != "" {
		return remote
	}
	return r.RemoteAddr
}

func remoteHost(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return stripPort(addr)
	}
	return host
}

func stripPort(addr string) string {
	if host, _, err := net.SplitHostPort(addr); err == nil {
		return host
	}
	return strings.Trim(addr, "[]")
}

func trustedProxy(ip string) bool {
	parsed := net.ParseIP(strings.Trim(ip, "[]"))
	// Loopback (Caddy on the same host) or private (docker/LAN proxy hop).
	return parsed != nil && (parsed.IsLoopback() || parsed.IsPrivate())
}

func deviceOnline(lastSeen sql.NullInt64, now int64) bool {
	return lastSeen.Valid && lastSeen.Int64 > 0 && now-lastSeen.Int64 <= OnlineWithinSec
}
