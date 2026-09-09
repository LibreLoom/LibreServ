package domainname

import (
	"strings"
	"unicode"
)

var reserved = map[string]struct{}{
	// Cross-product / zone / brand
	"luna": {}, "free": {}, "serv": {}, "servers": {},
	"libreserv": {}, "libreloom": {}, "connect": {},
	// Infra
	"www": {}, "api": {}, "admin": {}, "mail": {}, "smtp": {}, "mx": {},
	"ns": {}, "dns": {}, "cdn": {}, "status": {}, "tunnel": {},
	"auth": {}, "login": {}, "oauth": {}, "sso": {},
	"webhook": {}, "webhooks": {}, "internal": {}, "localhost": {},
	"root": {}, "system": {}, "caddy": {}, "cloudflare": {},
	"dashboard": {}, "panel": {}, "support": {},
}

func Normalize(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

func Validate(name string) string {
	n := Normalize(name)
	if len(n) < 3 || len(n) > 32 {
		return "Pick a name between 3 and 32 letters or numbers."
	}
	if _, ok := reserved[n]; ok {
		return "That name is reserved for LibreLoom. Try another."
	}
	if n[0] == '-' || n[len(n)-1] == '-' {
		return "A name cannot start or end with a dash."
	}
	for _, r := range n {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' {
			if r > 127 {
				return "Use only letters, numbers, and dashes."
			}
			continue
		}
		return "Use only letters, numbers, and dashes."
	}
	return ""
}

// Hostname joins a device subdomain with the public zone.
// Returns "" when sub/zone are empty or not a single safe DNS label + zone,
// so health probes and DNS API calls cannot be steered off-zone.
func Hostname(sub, zone string) string {
	n := Normalize(sub)
	z := strings.ToLower(strings.TrimSpace(zone))
	z = strings.TrimPrefix(z, ".")
	if n == "" || z == "" {
		return ""
	}
	// Subdomain must be one label (no dots / separators) — multi-label values
	// could point probes at an attacker-chosen host outside PublicZone.
	if strings.Contains(n, ".") || strings.ContainsAny(n, " /:\\@") {
		return ""
	}
	if strings.Contains(z, "..") || strings.ContainsAny(z, " /:\\@") {
		return ""
	}
	for _, r := range n {
		if !(unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-') || r > 127 {
			return ""
		}
	}
	for _, label := range strings.Split(z, ".") {
		if label == "" || label[0] == '-' || label[len(label)-1] == '-' {
			return ""
		}
		for _, r := range label {
			if !(unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-') || r > 127 {
				return ""
			}
		}
	}
	return n + "." + z
}
