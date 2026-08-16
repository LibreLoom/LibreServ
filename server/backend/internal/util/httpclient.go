package util

import (
	"net/http"
	"time"
)

// SecureHTTPClient is the recommended client for all outbound HTTP requests.
// It has conservative timeouts to mitigate SSRF/DoS (H-4) and is safe for most use cases.
var SecureHTTPClient = &http.Client{
	Timeout: 30 * time.Second,
	// Limit redirects to prevent abuse
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return http.ErrUseLastResponse
		}
		return nil
	},
}
