package smtp

import (
	"bufio"
	"database/sql"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/textproto"
	"strings"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
)

// SendingDomain is the domain all user sending addresses use.
const SendingDomain = "resend.libreloom.org"

// Server is an SMTP server that authenticates device relay connections and
// forwards their mail to Resend's REST API. Each user gets credentials
// (username@resend.libreloom.org / smtp_password) and can only send from
// their own address.
type Server struct {
	db        *sql.DB
	resend    *providers.ResendClient
	listener  net.Listener
	wg        sync.WaitGroup
	resendKey func() string
}

// NewServer creates an SMTP relay server. resendKey returns the current
// Resend API key (looked up from service_providers on each send).
func NewServer(db *sql.DB, resend *providers.ResendClient, resendKey func() string) *Server {
	return &Server{
		db:        db,
		resend:    resend,
		resendKey: resendKey,
	}
}

// Start begins listening for SMTP connections on the configured address.
func (s *Server) Start() error {
	addr := config.C.SMTP.RelayAddr
	if addr == "" {
		addr = ":2525"
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return fmt.Errorf("smtp: could not listen on %s: %w", addr, err)
	}
	s.listener = ln
	slog.Info("smtp relay listening", "addr", addr)

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
	authed   bool
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
			sess.sendLine("250-AUTH PLAIN LOGIN")
			sess.sendLine("250 OK")

		case strings.HasPrefix(cmd, "AUTH"):
			sess.handleAuth(line)

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

	var storedPassword string
	err := sess.s.db.QueryRow(
		"SELECT smtp_password FROM customer_accounts WHERE username = $1 AND is_active = TRUE",
		username).Scan(&storedPassword)
	if err != nil || storedPassword == "" || storedPassword != password {
		sess.sendLine("535 authentication failed")
		return
	}

	sess.authed = true
	sess.username = username
	sess.sendLine("235 authenticated")
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
	expectedFrom := sess.username + "@" + SendingDomain
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

	// Read until \r\n.\r\n
	var body strings.Builder
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
		body.WriteString(line)
		body.WriteString("\r\n")
	}

	// Forward each recipient via Resend
	apiKey := sess.s.resendKey()
	if apiKey == "" {
		sess.sendLine("421 email service not configured")
		return
	}

	fromAddr := sess.username + "@" + SendingDomain
	html := body.String()

	sent := 0
	var lastErr error
	for _, rcpt := range sess.rcpts {
		err := sess.s.resend.SendEmail(apiKey, fromAddr, rcpt, extractSubject(html), html)
		if err != nil {
			lastErr = err
			slog.Error("smtp relay: failed to forward email", "from", fromAddr, "to", rcpt, "error", err)
		} else {
			sent++
		}
	}

	if sent > 0 {
		sess.sendLine("250 OK: queued for delivery")
	} else {
		sess.sendLine("550 could not send email: " + lastErr.Error())
	}

	sess.reset()
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

// extractSubject tries to find the Subject header in the raw email.
func extractSubject(raw string) string {
	for _, line := range strings.Split(raw, "\r\n") {
		if strings.HasPrefix(strings.ToLower(line), "subject:") {
			return strings.TrimSpace(line[8:])
		}
	}
	return "(no subject)"
}
