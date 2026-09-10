package monitoring

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// errHTTPCheckRedirect refuses HTTP redirects. A loopback health target that
// 302s to a private or metadata address would otherwise bypass URL checks.
var errHTTPCheckRedirect = fmt.Errorf("http health check redirects are not followed")

// ipv4FromAny returns an IPv4 address from a plain IPv4, an IPv4-mapped
// IPv6 (::ffff:a.b.c.d), or a deprecated IPv4-compatible IPv6 (::a.b.c.d).
// Go's IP.To4 only handles the mapped form; compatible form is the gap
// closed for Luna update hosts (#294) and webhook SSRF (#309).
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

// isLoopbackHTTPCheckIP reports whether ip is loopback, including deprecated
// IPv4-compatible IPv6 encodings of 127.0.0.0/8.
func isLoopbackHTTPCheckIP(ip net.IP) bool {
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

// isBlockedHTTPCheckIP reports whether a resolved health-check destination
// must not be contacted. Loopback is allowed (installer publishes app checks
// as http://localhost:<port>/…). Other private, link-local, CGNAT, and
// metadata-adjacent ranges are blocked.
func isBlockedHTTPCheckIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if isLoopbackHTTPCheckIP(ip) {
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
	if to4[0] == 169 && to4[1] == 254 { // link-local / cloud metadata
		return true
	}
	if to4[0] == 100 && to4[1] >= 64 && to4[1] <= 127 { // CGNAT
		return true
	}
	if to4.IsPrivate() || to4.IsUnspecified() || to4.IsMulticast() || to4.IsLinkLocalUnicast() {
		return true
	}
	return false
}

var httpCheckMetadataHostnames = []string{
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

// validateHTTPCheckURL ensures a health-check URL uses http(s) and does not
// resolve to a blocked private/metadata destination. Loopback is permitted.
func validateHTTPCheckURL(raw string) error {
	if raw == "" {
		return fmt.Errorf("http health check URL is empty")
	}
	parsed, err := url.Parse(raw)
	if err != nil {
		return fmt.Errorf("invalid http health check URL: %w", err)
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return fmt.Errorf("http health check URL must use http or https scheme, got: %s", parsed.Scheme)
	}
	host := parsed.Hostname()
	if host == "" {
		return fmt.Errorf("http health check URL hostname is empty")
	}

	lower := strings.ToLower(host)
	for _, endpoint := range httpCheckMetadataHostnames {
		if lower == endpoint {
			return fmt.Errorf("http health check URL cannot target cloud metadata endpoints")
		}
	}

	ips, err := net.LookupIP(host)
	if err != nil {
		ip := net.ParseIP(host)
		if ip == nil {
			return fmt.Errorf("failed to resolve http health check hostname: %w", err)
		}
		ips = []net.IP{ip}
	}
	for _, ip := range ips {
		if isBlockedHTTPCheckIP(ip) {
			return fmt.Errorf("http health check URL resolves to a blocked address: %s", ip)
		}
	}
	return nil
}

// newHTTPCheckClient builds a client that never follows redirects and that
// re-validates dial targets so DNS rebinding cannot steer a check off-policy.
func newHTTPCheckClient(timeout time.Duration) *http.Client {
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	base := &net.Dialer{Timeout: timeout}
	return &http.Client{
		Timeout: timeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errHTTPCheckRedirect
		},
		Transport: &http.Transport{
			Proxy: http.ProxyFromEnvironment,
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
						if isBlockedHTTPCheckIP(addr.IP) {
							lastDialErr = fmt.Errorf("http health check dial blocked for address: %s", addr.IP)
							continue
						}
						conn, dialErr := base.DialContext(ctx, network, net.JoinHostPort(addr.IP.String(), port))
						if dialErr == nil {
							return conn, nil
						}
						lastDialErr = dialErr
					}
					if lastDialErr == nil {
						lastDialErr = fmt.Errorf("http health check dial blocked: no allowed addresses for %s", host)
					}
					return nil, lastDialErr
				}
				if isBlockedHTTPCheckIP(ip) {
					return nil, fmt.Errorf("http health check dial blocked for address: %s", ip)
				}
				return base.DialContext(ctx, network, address)
			},
		},
	}
}
