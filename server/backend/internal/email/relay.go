package email

import (
	"bufio"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/textproto"
	"strings"
	"sync"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

// Relay is a local SMTP server that apps send mail to. It accepts
// unauthenticated connections on localhost and forwards all mail to the
// configured upstream SMTP server (Connect's relay or a user-configured
// SMTP server). This lets apps use a simple localhost SMTP without
// needing credentials, while the relay handles authentication upstream.
type Relay struct {
	listener net.Listener
	wg       sync.WaitGroup
	upstream upstreamConfig
}

type upstreamConfig struct {
	host     string
	port     int
	username string
	password string
	from     string
}

// NewRelay creates a local SMTP relay. It reads the upstream config from
// the global SMTP config (set by Connect provisioning or manual config).
// If SMTP is not configured, the relay still runs but will reject mail
// with a helpful error.
func NewRelay() *Relay {
	cfg := config.Get()
	r := &Relay{}
	if cfg != nil && cfg.SMTP.Host != "" {
		r.upstream = upstreamConfig{
			host:     cfg.SMTP.Host,
			port:     cfg.SMTP.Port,
			username: cfg.SMTP.Username,
			password: cfg.SMTP.Password,
			from:     cfg.SMTP.From,
		}
	}
	return r
}

// Start begins listening on localhost:25.
func (r *Relay) Start() error {
	addr := "127.0.0.1:25"
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		// Port 25 might be in use — try 2525 as fallback
		addr = "127.0.0.1:2525"
		ln, err = net.Listen("tcp", addr)
		if err != nil {
			return fmt.Errorf("could not start SMTP relay on port 25 or 2525: %w", err)
		}
	}
	r.listener = ln
	slog.Info("SMTP relay listening", "addr", addr)

	r.wg.Add(1)
	go r.acceptLoop()
	return nil
}

// Stop gracefully shuts down the relay.
func (r *Relay) Stop() {
	if r.listener != nil {
		r.listener.Close()
	}
	r.wg.Wait()
}

func (r *Relay) acceptLoop() {
	defer r.wg.Done()
	for {
		conn, err := r.listener.Accept()
		if err != nil {
			return
		}
		r.wg.Add(1)
		go r.handleConn(conn)
	}
}

func (r *Relay) handleConn(conn net.Conn) {
	defer r.wg.Done()
	defer conn.Close()

	sess := &relaySession{
		relay: r,
		conn:  conn,
		tp:    textproto.NewReader(bufio.NewReader(conn)),
		w:     conn,
	}
	sess.sendLine("220 localhost SMTP relay ready")

	for {
		line, err := sess.tp.ReadLine()
		if err != nil {
			return
		}
		line = strings.TrimSpace(line)
		cmd := strings.ToUpper(line)

		switch {
		case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
			sess.sendLine("250-localhost")
			sess.sendLine("250 OK")

		case strings.HasPrefix(cmd, "AUTH"):
			// Local relay — no auth needed. Accept and ignore.
			sess.sendLine("235 OK")

		case strings.HasPrefix(cmd, "MAIL FROM"):
			sess.from = extractAngleAddr(line)
			if sess.from == "" {
				sess.sendLine("501 invalid address")
			} else {
				sess.sendLine("250 OK")
			}

		case strings.HasPrefix(cmd, "RCPT TO"):
			addr := extractAngleAddr(line)
			if addr == "" {
				sess.sendLine("501 invalid address")
			} else {
				sess.rcpts = append(sess.rcpts, addr)
				sess.sendLine("250 OK")
			}

		case strings.HasPrefix(cmd, "DATA"):
			sess.handleData()

		case strings.HasPrefix(cmd, "QUIT"):
			sess.sendLine("221 Bye")
			return

		case strings.HasPrefix(cmd, "RSET"):
			sess.from = ""
			sess.rcpts = nil
			sess.sendLine("250 OK")

		case strings.HasPrefix(cmd, "NOOP"):
			sess.sendLine("250 OK")

		default:
			sess.sendLine("500 unrecognized command")
		}
	}
}

type relaySession struct {
	relay *Relay
	conn  net.Conn
	tp    *textproto.Reader
	w     io.Writer
	from  string
	rcpts []string
}

func (s *relaySession) sendLine(line string) {
	fmt.Fprintf(s.w, "%s\r\n", line)
}

func (s *relaySession) handleData() {
	if len(s.rcpts) == 0 {
		s.sendLine("503 need RCPT TO first")
		return
	}
	if s.relay.upstream.host == "" {
		s.sendLine("421 email sending is not configured on this device. Connect to LibreServ Connect or configure SMTP in Settings.")
		return
	}

	s.sendLine("354 start mail input")

	// Read message body until \r\n.\r\n
	var body strings.Builder
	for {
		line, err := s.tp.ReadLine()
		if err != nil {
			return
		}
		if line == "." {
			break
		}
		if strings.HasPrefix(line, "..") {
			line = line[1:]
		}
		body.WriteString(line)
		body.WriteString("\r\n")
	}

	// Forward to upstream using the existing Sender
	cfg := config.SMTPConfig{
		Host:     s.relay.upstream.host,
		Port:     s.relay.upstream.port,
		Username: s.relay.upstream.username,
		Password: s.relay.upstream.password,
		From:     s.relay.upstream.from,
	}
	sender, err := NewSenderWithConfig(cfg)
	if err != nil {
		s.sendLine("421 email service not configured")
		return
	}

	// Use the original From header if present, otherwise the configured from
	from := s.from
	if from == "" {
		from = s.relay.upstream.from
	}

	if err := sender.SendRaw(s.rcpts, from, body.String()); err != nil {
		slog.Error("SMTP relay: failed to forward to upstream", "error", err, "from", from, "recipients", s.rcpts)
		s.sendLine("550 could not send email: " + err.Error())
	} else {
		s.sendLine("250 OK: queued for delivery")
	}

	s.from = ""
	s.rcpts = nil
}

// extractAngleAddr pulls the email address out of <...> in an SMTP command.
func extractAngleAddr(line string) string {
	start := strings.Index(line, "<")
	end := strings.Index(line, ">")
	if start == -1 || end == -1 || end < start {
		return ""
	}
	return line[start+1 : end]
}
