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

// MaxLunasPerAccount caps how many Lunas one account may bind and how many
// cloud Luna IDs it may claim. Each Luna that stores something gets its own
// Backblaze bucket, and the Backblaze account allows only so many.
const MaxLunasPerAccount = 25

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
		// Cloudflare sets CF-Connecting-IP; the local Caddy passes it through.
		// Only a proxy may set these headers: trusting them from any other peer
		// would let that peer pick a new client address per request and reset
		// the per-IP limits. Peers allowed to speak for a client are loopback
		// (the shipped Caddy) and whatever trusted_proxies lists.
		// Prefer CF-Connecting-IP over XFF so we do not bucket everyone on the
		// edge/proxy IP.
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
