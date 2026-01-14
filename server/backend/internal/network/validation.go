package network

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// domainLabelRegex matches a valid DNS label (subdomain component).
// Labels must start with alphanumeric, can contain hyphens, and be 1-63 chars.
var domainLabelRegex = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$`)

// ValidateDomain checks that a domain name is safe for use in Caddyfile generation.
// It prevents injection attacks by ensuring the domain contains only valid DNS characters.
func ValidateDomain(domain string) error {
	if domain == "" {
		return fmt.Errorf("%w: domain cannot be empty", ErrInvalidDomain)
	}

	// Max total length for a domain is 253 characters
	if len(domain) > 253 {
		return fmt.Errorf("%w: domain exceeds maximum length of 253 characters", ErrInvalidDomain)
	}

	// Check for characters that could enable Caddyfile injection
	if strings.ContainsAny(domain, " \t\n\r{}\"'`\\;#") {
		return fmt.Errorf("%w: domain contains invalid characters", ErrInvalidDomain)
	}

	// Split into labels and validate each
	labels := strings.Split(domain, ".")
	if len(labels) < 1 {
		return fmt.Errorf("%w: domain must have at least one label", ErrInvalidDomain)
	}

	for _, label := range labels {
		if label == "" {
			return fmt.Errorf("%w: domain contains empty label", ErrInvalidDomain)
		}
		if len(label) > 63 {
			return fmt.Errorf("%w: domain label exceeds 63 characters", ErrInvalidDomain)
		}
		// Allow wildcard only as first label
		if label == "*" {
			if labels[0] != "*" {
				return fmt.Errorf("%w: wildcard (*) only allowed as first label", ErrInvalidDomain)
			}
			continue
		}
		if !domainLabelRegex.MatchString(label) {
			return fmt.Errorf("%w: invalid domain label %q", ErrInvalidDomain, label)
		}
	}

	return nil
}

// ValidateSubdomain checks that a subdomain is safe for use in Caddyfile generation.
func ValidateSubdomain(subdomain string) error {
	if subdomain == "" {
		return nil // Empty subdomain is allowed (means use domain directly)
	}

	// Subdomain follows same rules as a single domain label
	if len(subdomain) > 63 {
		return fmt.Errorf("%w: subdomain exceeds 63 characters", ErrInvalidDomain)
	}

	if strings.ContainsAny(subdomain, " \t\n\r{}\"'`\\;#.") {
		return fmt.Errorf("%w: subdomain contains invalid characters", ErrInvalidDomain)
	}

	if !domainLabelRegex.MatchString(subdomain) {
		return fmt.Errorf("%w: invalid subdomain %q", ErrInvalidDomain, subdomain)
	}

	return nil
}

// ValidateBackend checks that a backend URL is safe for use in Caddyfile generation.
// It ensures the backend is a valid URL with an allowed scheme and no injection characters.
func ValidateBackend(backend string) error {
	if backend == "" {
		return fmt.Errorf("%w: backend cannot be empty", ErrInvalidBackend)
	}

	// Check for characters that could enable Caddyfile injection
	if strings.ContainsAny(backend, " \t\n\r{}\"'`\\;#") {
		return fmt.Errorf("%w: backend contains invalid characters", ErrInvalidBackend)
	}

	// Parse as URL
	u, err := url.Parse(backend)
	if err != nil {
		return fmt.Errorf("%w: %v", ErrInvalidBackend, err)
	}

	// Only allow http and https schemes (and unix sockets)
	switch u.Scheme {
	case "http", "https":
		// Valid schemes
	case "unix":
		// Unix socket - validate path doesn't have injection chars
		if strings.ContainsAny(u.Path, " \t\n\r{}\"'`\\;#") {
			return fmt.Errorf("%w: unix socket path contains invalid characters", ErrInvalidBackend)
		}
	case "":
		// No scheme - could be just host:port, which Caddy accepts
		// Validate it looks like host:port
		if !isValidHostPort(backend) {
			return fmt.Errorf("%w: backend must be a valid URL or host:port", ErrInvalidBackend)
		}
	default:
		return fmt.Errorf("%w: unsupported scheme %q (use http, https, or unix)", ErrInvalidBackend, u.Scheme)
	}

	// Validate host if present
	if u.Host != "" {
		host := u.Hostname()
		if host != "" && host != "localhost" {
			// For IP addresses, url.Parse handles validation
			// For hostnames, do basic validation
			if !isValidHost(host) {
				return fmt.Errorf("%w: invalid host in backend URL", ErrInvalidBackend)
			}
		}
	}

	return nil
}

// isValidHostPort checks if a string looks like a valid host:port
func isValidHostPort(s string) bool {
	// Simple check: should contain a colon and valid characters
	if !strings.Contains(s, ":") {
		return false
	}
	// Only alphanumeric, dots, hyphens, colons, and brackets (for IPv6)
	for _, r := range s {
		if !isValidHostChar(r) {
			return false
		}
	}
	return true
}

// isValidHost checks if a hostname is valid
func isValidHost(host string) bool {
	// Allow localhost, IP addresses, and valid domain names
	if host == "localhost" {
		return true
	}
	// Check each character is valid for a hostname
	for _, r := range host {
		if !isValidHostChar(r) {
			return false
		}
	}
	return len(host) > 0 && len(host) <= 253
}

// isValidHostChar returns true if the rune is valid in a hostname
func isValidHostChar(r rune) bool {
	return (r >= 'a' && r <= 'z') ||
		(r >= 'A' && r <= 'Z') ||
		(r >= '0' && r <= '9') ||
		r == '.' || r == '-' || r == ':' || r == '[' || r == ']'
}
