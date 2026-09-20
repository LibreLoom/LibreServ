package util

import (
	"fmt"
	"net/http"
	"time"
)

// errSecureHTTPRedirect refuses HTTP redirects. Callers that need a single-hop
// response must treat redirect status codes themselves; following redirects
// would reopen SSRF via a public URL that 302s to a private or metadata host.
var errSecureHTTPRedirect = fmt.Errorf("secure HTTP client does not follow redirects")

// SecureHTTPClient is the recommended client for all outbound HTTP requests.
// It has conservative timeouts and never follows redirects (SSRF mitigation).
var SecureHTTPClient = &http.Client{
	Timeout: 30 * time.Second,
	CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
		return errSecureHTTPRedirect
	},
}
