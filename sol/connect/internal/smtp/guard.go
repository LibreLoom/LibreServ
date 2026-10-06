package smtp

import (
	"crypto/tls"
	"fmt"
	"net"
	"os"
	"sync"
	"time"
)

const (
	// maxAuthFailures failed sign-ins from one IP within authFailureWindow
	// block that IP until the window passes.
	maxAuthFailures   = 10
	authFailureWindow = 15 * time.Minute
	// maxSessionAuthFailures closes a single connection early.
	maxSessionAuthFailures = 3
)

// certReloader serves the relay certificate and picks up renewed files
// without a restart: certbot replaces them every couple of months.
type certReloader struct {
	certPath, keyPath string

	mu      sync.Mutex
	cert    *tls.Certificate
	modTime time.Time
}

func newCertReloader(certPath, keyPath string) (*certReloader, error) {
	if certPath == "" || keyPath == "" {
		return nil, fmt.Errorf("set both smtp.relay_tls_cert and smtp.relay_tls_key")
	}
	r := &certReloader{certPath: certPath, keyPath: keyPath}
	if _, err := r.load(); err != nil {
		return nil, err
	}
	return r, nil
}

// load reads the pair again when either file changed since the last read.
func (r *certReloader) load() (*tls.Certificate, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	newest, err := newestModTime(r.certPath, r.keyPath)
	if err != nil {
		if r.cert != nil {
			return r.cert, nil // keep serving the last good pair
		}
		return nil, err
	}
	if r.cert != nil && !newest.After(r.modTime) {
		return r.cert, nil
	}
	pair, err := tls.LoadX509KeyPair(r.certPath, r.keyPath)
	if err != nil {
		if r.cert != nil {
			return r.cert, nil // mid-rename; next handshake retries
		}
		return nil, err
	}
	r.cert, r.modTime = &pair, newest
	return r.cert, nil
}

func (r *certReloader) GetCertificate(*tls.ClientHelloInfo) (*tls.Certificate, error) {
	return r.load()
}

func newestModTime(paths ...string) (time.Time, error) {
	var newest time.Time
	for _, p := range paths {
		info, err := os.Stat(p)
		if err != nil {
			return time.Time{}, err
		}
		if info.ModTime().After(newest) {
			newest = info.ModTime()
		}
	}
	return newest, nil
}

// authLimiter counts failed sign-ins per client IP so the internet-facing
// relay can't be used to guess passwords.
type authLimiter struct {
	max    int
	window time.Duration
	now    func() time.Time

	mu       sync.Mutex
	failures map[string][]time.Time
}

func newAuthLimiter(max int, window time.Duration) *authLimiter {
	return &authLimiter{max: max, window: window, now: time.Now, failures: map[string][]time.Time{}}
}

func (l *authLimiter) fail(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.failures[ip] = append(l.recent(ip), l.now())
}

func (l *authLimiter) blocked(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	return len(l.recent(ip)) >= l.max
}

// recent drops failures older than the window. Caller holds mu.
func (l *authLimiter) recent(ip string) []time.Time {
	cutoff := l.now().Add(-l.window)
	kept := l.failures[ip][:0]
	for _, t := range l.failures[ip] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		delete(l.failures, ip)
		return nil
	}
	l.failures[ip] = kept
	return kept
}

func remoteIP(conn net.Conn) string {
	host, _, err := net.SplitHostPort(conn.RemoteAddr().String())
	if err != nil {
		return conn.RemoteAddr().String()
	}
	return host
}
