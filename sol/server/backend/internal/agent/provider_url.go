package agent

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// errInferenceRedirect refuses HTTP redirects. A public or loopback inference
// base URL that 302s to a private or metadata address would otherwise bypass
// validateInferenceBaseURL (same class of gap closed for webhooks and HTTP
// health checks).
var errInferenceRedirect = fmt.Errorf("inference provider redirects are not followed")

var inferenceMetadataHostnames = []string{
	"169.254.169.254",
	"169.254.170.2",
	"169.254.169.253",
	"metadata.google.internal",
	"metadata.azure.internal",
	"instance-data",
	"metadata",
	"100.100.100.200",
	"fd00:ec2::254",
}

// ipv4FromAny returns an IPv4 address from a plain IPv4, an IPv4-mapped
// IPv6 (::ffff:a.b.c.d), or a deprecated IPv4-compatible IPv6 (::a.b.c.d).
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

func isLoopbackInferenceIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}
	if v4 := ipv4FromAny(ip); v4 != nil {
		return v4.IsLoopback()
	}
	return false
}

// isBlockedInferenceIP reports destinations the agent HTTP client must not
// dial. Loopback is allowed (local Ollama / BYOK). Other private, link-local,
// CGNAT, and metadata-adjacent ranges are blocked.
func isBlockedInferenceIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if isLoopbackInferenceIP(ip) {
		return false
	}
	if ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return true
	}
	v4 := ipv4FromAny(ip)
	if v4 == nil {
		return false
	}
	to4 := v4.To4()
	if to4 == nil {
		return false
	}
	if to4[0] == 169 && to4[1] == 254 {
		return true
	}
	if to4[0] == 100 && to4[1] >= 64 && to4[1] <= 127 {
		return true
	}
	if to4.IsPrivate() || to4.IsUnspecified() || to4.IsMulticast() || to4.IsLinkLocalUnicast() {
		return true
	}
	return false
}

func isLoopbackHostname(host string) bool {
	lower := strings.ToLower(host)
	if lower == "localhost" || strings.HasSuffix(lower, ".localhost") {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return isLoopbackInferenceIP(ip)
	}
	return false
}

// ValidateInferenceBaseURL ensures a BYOK / inference base URL is safe to
// contact. Empty clears the setting. Loopback may use http (local models);
// all other hosts require https and must not resolve to private/metadata
// addresses.
func ValidateInferenceBaseURL(raw string) error {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid inference base URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("inference base URL must use http or https scheme, got: %s", parsed.Scheme)
	}
	host := parsed.Hostname()
	if host == "" {
		return fmt.Errorf("inference base URL hostname is empty")
	}

	lower := strings.ToLower(host)
	for _, endpoint := range inferenceMetadataHostnames {
		if lower == endpoint {
			return fmt.Errorf("inference base URL cannot target cloud metadata endpoints")
		}
	}

	loopbackHost := isLoopbackHostname(host)
	if parsed.Scheme == "http" && !loopbackHost {
		return fmt.Errorf("inference base URL must use https for non-loopback hosts")
	}

	// Literal IPs are checked immediately. Hostnames are checked for known
	// metadata names above; private/CGNAT destinations are refused again at
	// dial time so config save stays offline-friendly and DNS-rebinding still
	// cannot steer the client into blocked ranges.
	if ip := net.ParseIP(host); ip != nil {
		if isBlockedInferenceIP(ip) {
			return fmt.Errorf("inference base URL resolves to a blocked address: %s", ip)
		}
		return nil
	}
	return nil
}

func newInferenceHTTPClient(timeout time.Duration) *http.Client {
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	base := &net.Dialer{Timeout: 30 * time.Second}
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errInferenceRedirect
		},
		Transport: &http.Transport{
			MaxIdleConns:        50,
			MaxIdleConnsPerHost: 20,
			MaxConnsPerHost:     30,
			IdleConnTimeout:     90 * time.Second,
			Proxy:               http.ProxyFromEnvironment,
			DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
				host, port, err := net.SplitHostPort(address)
				if err != nil {
					return nil, err
				}
				ip := net.ParseIP(host)
				if ip == nil {
					resolved, lookupErr := net.DefaultResolver.LookupIPAddr(ctx, host)
					if lookupErr != nil {
						return nil, lookupErr
					}
					var lastDialErr error
					for _, addr := range resolved {
						if isBlockedInferenceIP(addr.IP) {
							lastDialErr = fmt.Errorf("inference dial blocked for address: %s", addr.IP)
							continue
						}
						conn, dialErr := base.DialContext(ctx, network, net.JoinHostPort(addr.IP.String(), port))
						if dialErr == nil {
							return conn, nil
						}
						lastDialErr = dialErr
					}
					if lastDialErr == nil {
						lastDialErr = fmt.Errorf("inference dial blocked: no allowed addresses for %s", host)
					}
					return nil, lastDialErr
				}
				if isBlockedInferenceIP(ip) {
					return nil, fmt.Errorf("inference dial blocked for address: %s", ip)
				}
				return base.DialContext(ctx, network, address)
			},
		},
	}
}
