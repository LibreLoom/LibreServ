package monitoring

import (
	"context"
	"fmt"
	"net"
	"strings"
)

// validateTCPCheckHost ensures a TCP health-check host does not resolve to a
// blocked private/metadata destination. Loopback is permitted (installer uses
// localhost). Same policy as validateHTTPCheckURL, without URL/scheme parsing.
func validateTCPCheckHost(host string) error {
	if host == "" {
		return fmt.Errorf("tcp health check host is empty")
	}

	lower := strings.ToLower(host)
	for _, endpoint := range httpCheckMetadataHostnames {
		if lower == endpoint {
			return fmt.Errorf("tcp health check host cannot target cloud metadata endpoints")
		}
	}

	// Literal IP (including bracketless IPv6) — skip DNS.
	if ip := net.ParseIP(host); ip != nil {
		if isBlockedHTTPCheckIP(ip) {
			return fmt.Errorf("tcp health check host is a blocked address: %s", ip)
		}
		return nil
	}

	ips, err := net.LookupIP(host)
	if err != nil {
		return fmt.Errorf("failed to resolve tcp health check hostname: %w", err)
	}
	for _, ip := range ips {
		if isBlockedHTTPCheckIP(ip) {
			return fmt.Errorf("tcp health check host resolves to a blocked address: %s", ip)
		}
	}
	return nil
}

// dialTCPCheck connects only to destinations that pass isBlockedHTTPCheckIP,
// re-checking after DNS resolution so rebinding cannot steer the dial off-policy.
func dialTCPCheck(ctx context.Context, dialer *net.Dialer, host string, port int) (net.Conn, error) {
	address := net.JoinHostPort(host, fmt.Sprintf("%d", port))
	if ip := net.ParseIP(host); ip != nil {
		if isBlockedHTTPCheckIP(ip) {
			return nil, fmt.Errorf("tcp health check dial blocked for address: %s", ip)
		}
		return dialer.DialContext(ctx, "tcp", address)
	}

	resolved, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil {
		return nil, err
	}
	var lastDialErr error
	for _, addr := range resolved {
		if isBlockedHTTPCheckIP(addr.IP) {
			lastDialErr = fmt.Errorf("tcp health check dial blocked for address: %s", addr.IP)
			continue
		}
		conn, dialErr := dialer.DialContext(ctx, "tcp", net.JoinHostPort(addr.IP.String(), fmt.Sprintf("%d", port)))
		if dialErr == nil {
			return conn, nil
		}
		lastDialErr = dialErr
	}
	if lastDialErr == nil {
		lastDialErr = fmt.Errorf("tcp health check dial blocked: no allowed addresses for %s", host)
	}
	return nil, lastDialErr
}
