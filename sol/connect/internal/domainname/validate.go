// Package domainname validates LibreServ Connect subdomain prefixes and
// blocks claims that would collide with LibreLoom infrastructure.
//
// Paid Connect hosts are {name}.servers.libreloom.org. Luna Connect’s entire
// public zone is luna.servers.libreloom.org — so “luna” must never be a
// customer subdomain. “free” is the free-tier zone apex. Same idea as not
// selling google.com on Google Domains.
package domainname

import (
	"strings"
)

// reserved labels under *.servers.libreloom.org / *.free.servers.libreloom.org.
// Keep this list about zone and platform conflicts — not every nice word.
var reserved = map[string]struct{}{
	// Cross-product / zone apexes
	"luna": {}, "free": {},
	// Brand / product
	"libreserv": {}, "libreloom": {}, "connect": {}, "serv": {}, "servers": {},
	// Infra that must not become a customer hostname
	"www": {}, "api": {}, "admin": {}, "mail": {}, "smtp": {}, "mx": {},
	"ns": {}, "dns": {}, "cdn": {}, "status": {}, "tunnel": {},
	"auth": {}, "login": {}, "oauth": {}, "sso": {},
	"webhook": {}, "webhooks": {}, "internal": {}, "localhost": {},
	"root": {}, "system": {}, "caddy": {}, "cloudflare": {},
	"dashboard": {}, "panel": {}, "support": {},
}

// Normalize lowercases and trims a subdomain prefix. Does not validate.
func Normalize(s string) string {
	return strings.ToLower(strings.TrimSpace(s))
}

// IsReserved reports whether the label is blocked for customer claim.
func IsReserved(s string) bool {
	_, ok := reserved[Normalize(s)]
	return ok
}

// IsBrandOwned reports whether a custom domain is under a LibreLoom brand
// apex (including the apex itself). Customers must not register or attach
// these through Connect — same idea as not selling google.com on Google Domains.
func IsBrandOwned(domain string) bool {
	d := strings.ToLower(strings.TrimSpace(domain))
	d = strings.TrimSuffix(d, ".")
	for _, apex := range []string{"libreloom.org", "libreserv.org"} {
		if d == apex || strings.HasSuffix(d, "."+apex) {
			return true
		}
	}
	return false
}

// IsLibreLoomOwned is kept as an alias for callers; prefer IsBrandOwned.
func IsLibreLoomOwned(domain string) bool {
	return IsBrandOwned(domain)
}

// ValidateNormalizes a subdomain prefix for claim/rename.
// Returns ("", message) on failure; (normalized, "") on success.
func Validate(s string) (string, string) {
	n := Normalize(s)
	if len(n) < 3 || len(n) > 63 {
		return "", "Subdomains can only contain letters, numbers, and dashes (3-63 characters)."
	}
	for _, c := range n {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return "", "Subdomains can only contain letters, numbers, and dashes (3-63 characters)."
		}
	}
	if strings.HasPrefix(n, "-") || strings.HasSuffix(n, "-") {
		return "", "Subdomains can only contain letters, numbers, and dashes (3-63 characters)."
	}
	if IsReserved(n) {
		return "", "That name is reserved for LibreLoom. Pick another."
	}
	return n, ""
}
