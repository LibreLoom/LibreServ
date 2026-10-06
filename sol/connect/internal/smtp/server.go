package smtp

import (
	"bufio"
	"crypto/subtle"
	"crypto/tls"
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/mail"
	"net/textproto"
	"strings"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/catalog"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
)

// SendingDomain is the domain all sending addresses use.
const SendingDomain = "resend.libreloom.org"

// UserSuffix is appended to all user-chosen usernames to form the sending
// address. This prevents users from picking names that collide with system
// addresses (e.g., "admin", "noreply", "support"). System addresses use -s,
// user addresses use -u.
const UserSuffix = "-u"

// SendingAddress builds the full sending address for a user: username-u@resend.libreloom.org
func SendingAddress(username string) string {
	return username + UserSuffix + "@" + SendingDomain
}

type Server struct {
	db        *sql.DB
	resend    *providers.ResendClient
	listener  net.Listener
	wg        sync.WaitGroup
	resendKey func() string
	// passwordFor returns the stored relay password for an active account.
	// A seam so auth paths are testable without Postgres.
	passwordFor func(username string) (string, error)
	// tlsConfig is set when a certificate is configured. The relay is
	// reachable from the internet, so with TLS available AUTH is refused
	// until the client has issued STARTTLS.
	tlsConfig *tls.Config
	limiter   *authLimiter
}

// NewServer creates an SMTP relay server. resendKey returns the current
// Resend API key (looked up from service_providers on each send).
func NewServer(db *sql.DB, resend *providers.ResendClient, resendKey func() string) *Server {
	s := &Server{
		db:        db,
		resend:    resend,
		resendKey: resendKey,
		limiter:   newAuthLimiter(maxAuthFailures, authFailureWindow),
	}
	s.passwordFor = s.dbPassword
	return s
}

// Start begins listening for SMTP connections on the configured address.
func (s *Server) Start() error {
	addr := config.C.SMTP.RelayAddr
	if addr == "" {
		addr = ":2525"
	}
	cert, key := config.C.SMTP.RelayTLSCert, config.C.SMTP.RelayTLSKey
	if cert != "" || key != "" {
		reloader, err := newCertReloader(cert, key)
		if err != nil {
			return fmt.Errorf("smtp: could not load the relay certificate: %w", err)
		}
		s.tlsConfig = &tls.Config{
			GetCertificate: reloader.GetCertificate,
			MinVersion:     tls.VersionTLS12,
		}
	} else {
		slog.Warn("smtp relay has no certificate: devices send their password unencrypted. Set smtp.relay_tls_cert and smtp.relay_tls_key outside development")
	}
	// Both blue/green instances listen on the same port (SO_REUSEPORT), so
	// the relay stays up while either one restarts.
	ln, err := listenReusePort(addr)
	if err != nil {
		return fmt.Errorf("smtp: could not listen on %s: %w", addr, err)
	}
	s.listener = ln
	slog.Info("smtp relay listening", "addr", addr, "tls", s.tlsConfig != nil)

	s.wg.Add(1)
	go s.acceptLoop()
	return nil
}

// Stop gracefully shuts down the SMTP server.
func (s *Server) Stop() {
	if s.listener != nil {
		s.listener.Close()
	}
	s.wg.Wait()
}

func (s *Server) acceptLoop() {
	defer s.wg.Done()
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return // listener closed
		}
		s.wg.Add(1)
		go s.handleConn(conn)
	}
}

// session holds the state of a single SMTP connection.
type session struct {
	s        *Server
	conn     net.Conn
	tp       *textproto.Reader
	w        io.Writer
	tls      bool
	authed   bool
	failures int
	username string
	from     string
	rcpts    []string
	data     strings.Builder
}

func (s *Server) handleConn(conn net.Conn) {
	defer s.wg.Done()
	defer conn.Close()

	conn.SetDeadline(time.Now().Add(30 * time.Second))

	sess := &session{
		s:    s,
		conn: conn,
	}
	sess.tp = textproto.NewReader(bufio.NewReader(conn))
	sess.w = conn

	sess.sendLine("220 connect.libreloom.org SMTP relay ready")

	if s.limiter.blocked(remoteIP(conn)) {
		sess.sendLine("421 too many failed sign-ins from your address, try again later")
		return
	}

	for {
		line, err := sess.tp.ReadLine()
		if err != nil {
			return
		}
		line = strings.TrimSpace(line)

		cmd := strings.ToUpper(line)
		switch {
		case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
			sess.sendLine("250-connect.libreloom.org")
			if s.tlsConfig != nil && !sess.tls {
				sess.sendLine("250-STARTTLS")
			}
			if sess.authAllowed() {
				sess.sendLine("250-AUTH PLAIN LOGIN")
			}
			sess.sendLine("250 OK")

		case cmd == "STARTTLS":
			if !sess.startTLS() {
				return
			}

		case strings.HasPrefix(cmd, "AUTH"):
			if !sess.authAllowed() {
				sess.sendLine("530 5.7.0 Must issue a STARTTLS command first")
				continue
			}
			sess.handleAuth(line)
			if sess.failures >= maxSessionAuthFailures {
				sess.sendLine("421 too many failed sign-ins, closing connection")
				return
			}

		case strings.HasPrefix(cmd, "MAIL FROM"):
			sess.handleMailFrom(line)

		case strings.HasPrefix(cmd, "RCPT TO"):
			sess.handleRcptTo(line)

		case strings.HasPrefix(cmd, "DATA"):
			sess.handleData()

		case strings.HasPrefix(cmd, "QUIT"):
			sess.sendLine("221 Bye")
			return

		case strings.HasPrefix(cmd, "RSET"):
			sess.reset()
			sess.sendLine("250 OK")

		case strings.HasPrefix(cmd, "NOOP"):
			sess.sendLine("250 OK")

		default:
			sess.sendLine("500 unrecognized command")
		}
	}
}

// authAllowed reports whether AUTH may run now: always without a
// certificate (development), otherwise only inside TLS.
func (sess *session) authAllowed() bool {
	return sess.s.tlsConfig == nil || sess.tls
}

// startTLS upgrades the connection. Anything the client sent before the
// handshake is discarded with the old reader (no plaintext command
// injection), and the session starts over as RFC 3207 requires. Returns
// false when the connection must close.
func (sess *session) startTLS() bool {
	if sess.s.tlsConfig == nil {
		sess.sendLine("502 STARTTLS not available")
		return true
	}
	if sess.tls {
		sess.sendLine("503 already using TLS")
		return true
	}
	sess.sendLine("220 ready to start TLS")
	tlsConn := tls.Server(sess.conn, sess.s.tlsConfig)
	if err := tlsConn.Handshake(); err != nil {
		slog.Debug("smtp relay: TLS handshake failed", "error", err)
		return false
	}
	sess.conn = tlsConn
	sess.tp = textproto.NewReader(bufio.NewReader(tlsConn))
	sess.w = tlsConn
	sess.tls = true
	sess.authed = false
	sess.username = ""
	sess.reset()
	return true
}

func (sess *session) sendLine(line string) {
	fmt.Fprintf(sess.w, "%s\r\n", line)
}

func (sess *session) reset() {
	sess.from = ""
	sess.rcpts = nil
	sess.data.Reset()
}

// handleAuth processes AUTH PLAIN or AUTH LOGIN.
func (sess *session) handleAuth(line string) {
	if sess.authed {
		sess.sendLine("503 already authenticated")
		return
	}

	parts := strings.SplitN(line, " ", 3)
	method := ""
	if len(parts) >= 2 {
		method = strings.ToUpper(parts[1])
	}

	switch method {
	case "PLAIN":
		// AUTH PLAIN <base64-encoded-credentials>
		if len(parts) >= 3 {
			sess.tryAuthPlain(parts[2])
		} else {
			sess.sendLine("334 ")
			encoded, err := sess.tp.ReadLine()
			if err != nil {
				return
			}
			sess.tryAuthPlain(encoded)
		}

	case "LOGIN":
		sess.sendLine("334 VXNlcm5hbWU6") // "Username:"
		username, err := sess.tp.ReadLine()
		if err != nil {
			return
		}
		sess.sendLine("334 UGFzc3dvcmQ6") // "Password:"
		password, err := sess.tp.ReadLine()
		if err != nil {
			return
		}
		sess.tryAuthLogin(username, password)

	default:
		sess.sendLine("504 unsupported auth method")
	}
}

// tryAuthPlain decodes AUTH PLAIN and authenticates.
// Format: \0username\0password (base64-encoded)
func (sess *session) tryAuthPlain(encoded string) {
	decoded, err := base64Decode(encoded)
	if err != nil {
		sess.sendLine("535 authentication failed")
		return
	}
	// Split on \0: authzid \0 authcid \0 password
	parts := strings.Split(decoded, "\x00")
	if len(parts) < 3 {
		sess.sendLine("535 authentication failed")
		return
	}
	username := parts[1]
	password := parts[2]
	sess.authenticate(username, password)
}

// tryAuthLogin decodes AUTH LOGIN username and password (both base64).
func (sess *session) tryAuthLogin(encodedUser, encodedPass string) {
	username, err := base64Decode(encodedUser)
	if err != nil {
		sess.sendLine("535 authentication failed")
		return
	}
	password, err := base64Decode(encodedPass)
	if err != nil {
		sess.sendLine("535 authentication failed")
		return
	}
	sess.authenticate(username, password)
}

// authenticate checks credentials against the database.
func (sess *session) authenticate(username, password string) {
	// Username is the full sending address: username@resend.libreloom.org
	// or just the username part.
	username = strings.ToLower(strings.TrimSpace(username))
	if strings.Contains(username, "@") {
		username = strings.Split(username, "@")[0]
	}

	storedPassword, err := sess.s.passwordFor(username)
	if err != nil || storedPassword == "" ||
		subtle.ConstantTimeCompare([]byte(storedPassword), []byte(password)) != 1 {
		sess.failures++
		sess.s.limiter.fail(remoteIP(sess.conn))
		sess.sendLine("535 authentication failed")
		return
	}

	sess.authed = true
	sess.username = username
	sess.sendLine("235 authenticated")
}

// dbPassword reads the relay password for an active account.
func (s *Server) dbPassword(username string) (string, error) {
	var stored string
	err := s.db.QueryRow(
		"SELECT smtp_password FROM customer_accounts WHERE username = $1 AND is_active = TRUE",
		username).Scan(&stored)
	return stored, err
}

// handleMailFrom processes MAIL FROM:<address>.
func (sess *session) handleMailFrom(line string) {
	if !sess.authed {
		sess.sendLine("530 authentication required")
		return
	}
	sess.reset()

	// Extract address from MAIL FROM:<address>
	fromAddr := extractAddr(line)
	if fromAddr == "" {
		sess.sendLine("501 invalid address")
		return
	}

	// Enforce that the from address matches the authenticated user's sending address.
	expectedFrom := SendingAddress(sess.username)
	// Also allow the display-name format "Name <address>"
	fromAddrLower := strings.ToLower(fromAddr)
	if !strings.Contains(fromAddrLower, expectedFrom) {
		sess.sendLine(fmt.Sprintf("550 you can only send from %s", expectedFrom))
		return
	}

	sess.from = fromAddr
	sess.sendLine("250 OK")
}

// handleRcptTo processes RCPT TO:<address>.
func (sess *session) handleRcptTo(line string) {
	if sess.from == "" {
		sess.sendLine("503 need MAIL FROM first")
		return
	}
	addr := extractAddr(line)
	if addr == "" {
		sess.sendLine("501 invalid address")
		return
	}
	sess.rcpts = append(sess.rcpts, addr)
	sess.sendLine("250 OK")
}

// handleData reads the message body and forwards it via Resend.
func (sess *session) handleData() {
	if len(sess.rcpts) == 0 {
		sess.sendLine("503 need RCPT TO first")
		return
	}
	sess.sendLine("354 start mail input")

	// Read until \r\n.\r\n. Lines land in sess.data (reset at the start of
	// the transaction via handleMailFrom → reset, so that's the raw message).
	for {
		line, err := sess.tp.ReadLine()
		if err != nil {
			return
		}
		if line == "." {
			break
		}
		// Unstuff leading dots
		if strings.HasPrefix(line, "..") {
			line = line[1:]
		}
		sess.data.WriteString(line)
		sess.data.WriteString("\r\n")
	}

	// Forward each recipient via Resend
	apiKey := sess.s.resendKey()
	if apiKey == "" {
		sess.sendLine("421 email service not configured")
		return
	}

	fromAddr := SendingAddress(sess.username)
	raw := sess.data.String()
	subject, htmlBody, textBody := splitMessage(raw)

	sent := 0
	var lastErr error
	for _, rcpt := range sess.rcpts {
		err := sess.s.resend.SendEmail(apiKey, fromAddr, rcpt, subject, htmlBody, textBody)
		if err != nil {
			lastErr = err
			slog.Error("smtp relay: failed to forward email", "from", fromAddr, "to", rcpt, "error", err)
		} else {
			sent++
		}
	}

	if sent > 0 {
		// Meter usage for billing/quota: one email per delivered recipient.
		// The relay is the single chokepoint for all device email, so this
		// is the authoritative count.
		if err := sess.s.recordUsage(sess.username, sent); err != nil {
			slog.Warn("smtp relay: failed to record usage", "error", err)
		}
		sess.sendLine("250 OK: queued for delivery")
	} else {
		sess.sendLine("550 could not send email: " + lastErr.Error())
	}

	sess.reset()
}

// recordUsage attributes emails sent by a username to its device and records
// a usage event so quotas/billing can see real volume.
func (s *Server) recordUsage(username string, emails int) error {
	var deviceID, planID string
	err := s.db.QueryRow(
		`SELECT d.id, d.plan_id
		 FROM devices d
		 JOIN customer_accounts ca ON d.account_id = ca.id
		 WHERE ca.username = $1 AND d.is_active = TRUE
		 LIMIT 1`,
		username).Scan(&deviceID, &planID)
	if err != nil {
		return fmt.Errorf("lookup device for %q: %w", username, err)
	}
	cost := float64(emails) * catalog.Costs.SMTPPerEmail
	return billing.NewService(s.db).RecordUsage(deviceID, planID, "smtp", "emails", float64(emails), cost, cost)
}

// splitMessage splits a raw RFC 5322 message into subject, html body, and text
// body. The device (sol/server/backend/internal/email) sends a single-part message,
// so multipart/mixed is left unparsed and falls through to the plain-text path.
// ponytail: single-part only from our devices; if multipart support is ever
// needed, parse the MIME tree here instead of routing on Content-Type.
func splitMessage(raw string) (subject, htmlBody, textBody string) {
	subject = "(no subject)"

	msg, err := mail.ReadMessage(strings.NewReader(raw))
	if err != nil {
		// Not a valid message — send the raw payload as text so nothing is lost.
		return subject, "", raw
	}

	if s := msg.Header.Get("Subject"); s != "" {
		subject = s
	}

	body, err := io.ReadAll(msg.Body)
	if err != nil {
		return subject, "", raw
	}

	if strings.HasPrefix(strings.ToLower(msg.Header.Get("Content-Type")), "text/html") {
		return subject, string(body), ""
	}
	return subject, "", string(body)
}

// extractAddr pulls the email address out of <...> in an SMTP command.
func extractAddr(line string) string {
	start := strings.Index(line, "<")
	end := strings.Index(line, ">")
	if start == -1 || end == -1 || end < start {
		return ""
	}
	return line[start+1 : end]
}
