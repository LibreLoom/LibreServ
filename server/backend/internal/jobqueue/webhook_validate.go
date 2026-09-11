package jobqueue

import (
	"fmt"
	"net"
	"net/url"
	"strings"
)

// ipv4FromAny returns an IPv4 address from a plain IPv4, an IPv4-mapped
// IPv6 (::ffff:a.b.c.d), or a deprecated IPv4-compatible IPv6 (::a.b.c.d).
// Go's IP.To4 only handles the mapped form; compatible form is the gap.
func ipv4FromAny(ip net.IP) net.IP {
	if ip4 := ip.To4(); ip4 != nil {
		return ip4
	}
	if len(ip) != net.IPv6len {
		return nil
	}
	for i := 0; i < 12; i++ {
		if ip[i] != 0 {
			return nil
		}
	}
	return net.IP{ip[12], ip[13], ip[14], ip[15]}
}

// isBlockedWebhookIP reports whether a resolved webhook destination must not
// be contacted (SSRF hardening). Aligns with network.IsBlockedIP and also
// covers deprecated IPv4-compatible IPv6 forms (::a.b.c.d) that Go's
// IP.To4 / IPv4 CIDR Contains miss — the same class of gap closed for Luna
// update hosts in #294.
func isBlockedWebhookIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	// Check the address as given first (::1 must stay blocked here:
	// ipv4FromAny(::1) yields 0.0.0.1, which is not itself loopback).
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return true
	}
	ip4 := ipv4FromAny(ip)
	if ip4 == nil {
		return false
	}
	// Prefer a 4-byte form: net.IPv4(...) returns a 16-byte mapped address,
	// so indexing [0] would read 0 instead of the first IPv4 octet.
	v4 := ip4.To4()
	if v4 == nil {
		return false
	}
	if v4[0] == 169 && v4[1] == 254 { // link-local / cloud metadata
		return true
	}
	if v4[0] == 100 && v4[1] >= 64 && v4[1] <= 127 { // CGNAT
		return true
	}
	if v4.IsLoopback() || v4.IsPrivate() || v4.IsUnspecified() || v4.IsMulticast() || v4.IsLinkLocalUnicast() {
		return true
	}
	return false
}

// isPrivateIP is retained for callers/tests that pass string forms; prefer
// isBlockedWebhookIP for net.IP values.
func isPrivateIP(ip string) bool {
	if ip == "localhost" {
		return true
	}
	parsedIP := net.ParseIP(ip)
	if parsedIP == nil {
		return false
	}
	return isBlockedWebhookIP(parsedIP)
}

// validateWebhookURL validates and sanitizes a webhook URL for security
// It resolves hostnames to IPs immediately to prevent DNS rebinding attacks
func validateWebhookURL(webhookURL string, allowPrivate bool) error {
	if webhookURL == "" {
		return fmt.Errorf("webhook URL is empty")
	}

	parsedURL, err := url.Parse(webhookURL)
	if err != nil {
		return fmt.Errorf("invalid webhook URL: %w", err)
	}

	// Only allow HTTP and HTTPS schemes
	if parsedURL.Scheme != "http" && parsedURL.Scheme != "https" {
		return fmt.Errorf("webhook URL must use http or https scheme, got: %s", parsedURL.Scheme)
	}

	// SSRF Protection: Resolve hostname and check IPs
	host := parsedURL.Hostname()
	if host == "" {
		return fmt.Errorf("webhook URL hostname is empty")
	}
	if !allowPrivate && (strings.EqualFold(host, "localhost") || strings.HasSuffix(strings.ToLower(host), ".localhost")) {
		return fmt.Errorf("webhook URL resolves to private IP address: %s (SSRF protection)", host)
	}

	// Check for metadata endpoints by name (before DNS resolution)
	metadataHostnames := []string{
		"169.254.169.254",
		"169.254.170.2",
		"169.254.169.253",
		"metadata.google.internal",
		"instance-data",
		"metadata",
	}
	for _, endpoint := range metadataHostnames {
		if host == endpoint {
			return fmt.Errorf("webhook URL cannot target cloud metadata endpoints")
		}
	}

	// Resolve hostname to IP(s) immediately to prevent DNS rebinding
	// This ensures we validate the actual IP, not just the hostname
	ips, err := net.LookupIP(host)
	if err != nil {
		// If we can't resolve, check if it's already an IP
		ip := net.ParseIP(host)
		if ip == nil {
			return fmt.Errorf("failed to resolve webhook URL hostname: %w", err)
		}
		ips = []net.IP{ip}
	}

	// Check all resolved IPs
	for _, ip := range ips {
		ipStr := ip.String()

		// Check for metadata endpoints
		for _, endpoint := range metadataHostnames {
			if ipStr == endpoint {
				return fmt.Errorf("webhook URL resolves to cloud metadata endpoint: %s", ipStr)
			}
		}

		// Block private / link-local / CGNAT / IPv4-compatible forms
		if isBlockedWebhookIP(ip) && !allowPrivate {
			return fmt.Errorf("webhook URL resolves to private IP address: %s (SSRF protection)", ipStr)
		}
	}

	return nil
}
