package handlers

import (
	"context"
	"database/sql"
	"net"
	"net/http"
	"strings"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/mail"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/setuphub"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

type ctxKey string

const (
	deviceKey  ctxKey = "device"
	accountKey ctxKey = "account"
)

type Device struct {
	ID        string
	AccountID sql.NullString
	Subdomain string
	TunnelID  string
	Name      string
}

type Account struct {
	ID               string
	Email            string
	HasCard          bool
	Activated        bool
	BillingStatus    string
	StripeCustomer   string
	StripeSub        string
	BackupPurgeAfter int64
	EmailVerified    bool
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
	DB     *sql.DB
	Store  store.Store
	Tunnel providers.Tunnel
	DNS    providers.DNS
	Hub    *setuphub.Hub
	Mail   mail.Sender
}

func ClientIP(r *http.Request) string {
	remote := remoteHost(r.RemoteAddr)
	if trustedProxy(remote) {
		if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
			parts := strings.Split(xff, ",")
			if ip := strings.TrimSpace(parts[0]); ip != "" {
				return stripPort(ip)
			}
		}
		if xri := strings.TrimSpace(r.Header.Get("X-Real-IP")); xri != "" {
			return stripPort(xri)
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
	return parsed != nil && parsed.IsLoopback()
}
