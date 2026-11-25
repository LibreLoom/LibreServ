package handlers

import (
	"context"
	"database/sql"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"net"
	"net/http"
	"strings"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
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
	ID            string
	UID           string
	State         string
	AccountID     sql.NullString
	AuthTokenHash string
	Subdomain     string
	TunnelID      string
	Name          string
	Kind          string
	LastSeenAt    sql.NullInt64
	Revoked       bool
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
	if ip, ok := trustedProxyClientIP(r); ok {
		return ip
	}
	remote := remoteHost(r.RemoteAddr)
	if remote != "" {
		return remote
	}
	return r.RemoteAddr
}

// trustedProxyClientIP resolves forwarding headers only when the direct peer
// is allowed to speak for a client. The boolean is used by pairing's public-IP
// relaxation; a header from an untrusted peer never supplies network location.
func trustedProxyClientIP(r *http.Request) (string, bool) {
	remote := remoteHost(r.RemoteAddr)
	if !trustedProxy(remote) {
		return "", false
	}
	candidates := []string{
		strings.TrimSpace(r.Header.Get("CF-Connecting-IP")),
		strings.TrimSpace(r.Header.Get("X-Real-IP")),
	}
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		parts := strings.Split(xff, ",")
		if len(parts) > 0 {
			candidates = append(candidates, strings.TrimSpace(parts[0]))
		}
	}
	for _, candidate := range candidates {
		if candidate == "" {
			continue
		}
		ip := net.ParseIP(strings.Trim(stripPort(candidate), "[]"))
		if ip != nil {
			return ip.String(), true
		}
	}
	return "", false
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

// trustedProxy reports whether a peer may set the client-IP headers. Loopback
// is always trusted: the shipped deploy runs Caddy on 127.0.0.1 in front of
// two Connect instances, so it keeps working with no configuration. Any other
// proxy address must be listed in LUNACONNECT_TRUSTED_PROXIES — being on a
// private network is not enough, because the Connect port may be reachable
// from the whole LAN or container network.
func trustedProxy(ip string) bool {
	parsed := net.ParseIP(strings.Trim(ip, "[]"))
	if parsed == nil {
		return false
	}
	if parsed.IsLoopback() {
		return true
	}
	for _, network := range trustedProxyNetworks() {
		if network.Contains(parsed) {
			return true
		}
	}
	return false
}

// trustedProxyNetworks parses trusted_proxies. Malformed entries are ignored,
// which fails closed: only loopback (and any valid entries) stays trusted.
func trustedProxyNetworks() []*net.IPNet {
	var networks []*net.IPNet
	for _, entry := range strings.Split(config.C.TrustedProxies, ",") {
		entry = strings.TrimSpace(entry)
		if entry == "" {
			continue
		}
		if strings.Contains(entry, "/") {
			if _, network, err := net.ParseCIDR(entry); err == nil {
				networks = append(networks, network)
			}
			continue
		}
		addr := net.ParseIP(entry)
		if addr == nil {
			continue
		}
		if v4 := addr.To4(); v4 != nil {
			addr = v4
		}
		networks = append(networks, &net.IPNet{IP: addr, Mask: net.CIDRMask(8*len(addr), 8*len(addr))})
	}
	return networks
}
