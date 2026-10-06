package smtp

import (
	"bufio"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"math/big"
	"net"
	"net/smtp"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
)

const (
	testUser     = "relaytest"
	testPassword = "correct-horse-battery"
)

// writeCert writes a self-signed certificate for localhost and returns the
// file paths plus a pool that trusts it.
func writeCert(t *testing.T, dir, name string) (certPath, keyPath string, pool *x509.CertPool) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: name},
		DNSNames:     []string{"localhost"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	certPath = filepath.Join(dir, "relay.crt")
	keyPath = filepath.Join(dir, "relay.key")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(keyPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: keyDER}), 0o600); err != nil {
		t.Fatal(err)
	}
	parsed, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	pool = x509.NewCertPool()
	pool.AddCert(parsed)
	return certPath, keyPath, pool
}

// startTLSRelay runs a relay with a certificate and an in-memory account.
func startTLSRelay(t *testing.T) (addr string, pool *x509.CertPool, srv *Server) {
	t.Helper()
	certPath, keyPath, pool := writeCert(t, t.TempDir(), "relay-test")
	saved := config.C.SMTP
	config.C.SMTP.RelayAddr = "127.0.0.1:0"
	config.C.SMTP.RelayTLSCert = certPath
	config.C.SMTP.RelayTLSKey = keyPath
	t.Cleanup(func() { config.C.SMTP = saved })

	srv = NewServer(nil, nil, func() string { return "" })
	srv.passwordFor = func(username string) (string, error) {
		if username == testUser {
			return testPassword, nil
		}
		return "", errors.New("no such account")
	}
	if err := srv.Start(); err != nil {
		t.Fatalf("start relay: %v", err)
	}
	t.Cleanup(srv.Stop)
	return srv.listener.Addr().String(), pool, srv
}

// rawSession speaks SMTP line by line, for checks net/smtp won't make.
type rawSession struct {
	t    *testing.T
	conn net.Conn
	r    *bufio.Reader
}

func dialRaw(t *testing.T, addr string) *rawSession {
	t.Helper()
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { conn.Close() })
	s := &rawSession{t: t, conn: conn, r: bufio.NewReader(conn)}
	s.reply() // greeting
	return s
}

// reply reads one full (possibly multi-line) reply.
func (s *rawSession) reply() string {
	s.t.Helper()
	var lines []string
	for {
		line, err := s.r.ReadString('\n')
		if err != nil {
			return strings.Join(lines, "\n")
		}
		line = strings.TrimRight(line, "\r\n")
		lines = append(lines, line)
		if len(line) < 4 || line[3] != '-' {
			return strings.Join(lines, "\n")
		}
	}
}

func (s *rawSession) cmd(line string) string {
	s.t.Helper()
	if _, err := s.conn.Write([]byte(line + "\r\n")); err != nil {
		s.t.Fatal(err)
	}
	return s.reply()
}

func TestRelayWithCertRefusesAuthBeforeSTARTTLS(t *testing.T) {
	addr, _, _ := startTLSRelay(t)
	s := dialRaw(t, addr)

	ehlo := s.cmd("EHLO test")
	if !strings.Contains(ehlo, "STARTTLS") {
		t.Errorf("EHLO before TLS = %q, want STARTTLS offered", ehlo)
	}
	if strings.Contains(ehlo, "AUTH") {
		t.Errorf("EHLO before TLS = %q, must not offer AUTH", ehlo)
	}
	plain := "AGNvcnJlY3QtaG9yc2UtYmF0dGVyeQ==" // any credentials
	if got := s.cmd("AUTH PLAIN " + plain); !strings.HasPrefix(got, "530") {
		t.Errorf("AUTH before STARTTLS = %q, want 530", got)
	}
}

func TestRelayAuthenticatesAfterSTARTTLS(t *testing.T) {
	addr, pool, _ := startTLSRelay(t)
	c, err := smtp.Dial(addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.StartTLS(&tls.Config{RootCAs: pool, ServerName: "localhost"}); err != nil {
		t.Fatalf("STARTTLS: %v", err)
	}
	if ok, _ := c.Extension("AUTH"); !ok {
		t.Fatal("AUTH not offered after STARTTLS")
	}
	if ok, _ := c.Extension("STARTTLS"); ok {
		t.Error("STARTTLS still offered inside TLS")
	}
	if err := c.Auth(smtp.PlainAuth("", testUser, testPassword, "127.0.0.1")); err != nil {
		t.Fatalf("AUTH inside TLS: %v", err)
	}
}

func TestRelayClosesAfterRepeatedBadPasswords(t *testing.T) {
	addr, pool, _ := startTLSRelay(t)
	c, err := smtp.Dial(addr)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.StartTLS(&tls.Config{RootCAs: pool, ServerName: "localhost"}); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < maxSessionAuthFailures; i++ {
		if err := c.Auth(smtp.PlainAuth("", testUser, "wrong", "127.0.0.1")); err == nil {
			t.Fatal("wrong password accepted")
		}
	}
	// The relay said 421 and hung up; the connection is no longer usable.
	if err := c.Noop(); err == nil {
		t.Error("connection still open after repeated bad passwords")
	}
}

func TestRelayBlocksAddressAfterTooManyFailures(t *testing.T) {
	addr, _, srv := startTLSRelay(t)
	for i := 0; i < maxAuthFailures; i++ {
		srv.limiter.fail("127.0.0.1")
	}
	conn, err := net.Dial("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	r := bufio.NewReader(conn)
	_, _ = r.ReadString('\n') // greeting
	line, _ := r.ReadString('\n')
	if !strings.HasPrefix(line, "421") {
		t.Errorf("blocked address got %q, want 421", strings.TrimSpace(line))
	}
}

func TestAuthLimiterForgetsOldFailures(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	l := newAuthLimiter(2, time.Minute)
	l.now = func() time.Time { return now }
	l.fail("1.2.3.4")
	l.fail("1.2.3.4")
	if !l.blocked("1.2.3.4") {
		t.Fatal("not blocked after max failures")
	}
	if l.blocked("5.6.7.8") {
		t.Error("an unrelated address is blocked")
	}
	now = now.Add(2 * time.Minute)
	if l.blocked("1.2.3.4") {
		t.Error("still blocked after the window passed")
	}
}

func TestCertReloaderPicksUpRenewal(t *testing.T) {
	dir := t.TempDir()
	certPath, keyPath, _ := writeCert(t, dir, "first")
	r, err := newCertReloader(certPath, keyPath)
	if err != nil {
		t.Fatal(err)
	}
	first, _ := r.GetCertificate(nil)

	writeCert(t, dir, "renewed")
	future := time.Now().Add(time.Minute)
	for _, p := range []string{certPath, keyPath} {
		if err := os.Chtimes(p, future, future); err != nil {
			t.Fatal(err)
		}
	}
	second, err := r.GetCertificate(nil)
	if err != nil {
		t.Fatal(err)
	}
	if string(first.Certificate[0]) == string(second.Certificate[0]) {
		t.Error("renewed certificate was not loaded")
	}
}
