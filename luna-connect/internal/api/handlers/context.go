package handlers

import (
	"context"
	"database/sql"
	"net/http"

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
	ID             string
	Email          string
	HasCard        bool
	BillingStatus  string
	StripeCustomer string
	StripeSub      string
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
	Tunnel *providers.TunnelClient
	DNS    *providers.DNSClient
	Hub    *setuphub.Hub
}

func ClientIP(r *http.Request) string {
	if host, _, ok := splitHost(r.RemoteAddr); ok {
		return host
	}
	return r.RemoteAddr
}

func splitHost(addr string) (string, string, bool) {
	for i := len(addr) - 1; i >= 0; i-- {
		if addr[i] == ':' {
			return addr[:i], addr[i+1:], true
		}
	}
	return addr, "", false
}
