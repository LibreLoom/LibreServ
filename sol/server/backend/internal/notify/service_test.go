package notify

import (
	"bufio"
	"context"
	"fmt"
	"log/slog"
	"net"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database/models"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/email"
)

// smtpRecorder is a minimal SMTP server that accepts one message and records
// its envelope so tests can assert on what the notify service sent.
type smtpRecorder struct {
	listener net.Listener

	mu         sync.Mutex
	recipients []string
	data       string
	done       chan struct{}
}

func newSMTPRecorder(t *testing.T) *smtpRecorder {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s := &smtpRecorder{listener: ln, done: make(chan struct{})}
	go s.serve()
	t.Cleanup(func() { _ = ln.Close() })
	return s
}

func (s *smtpRecorder) addr() (host string, port int) {
	tcpAddr := s.listener.Addr().(*net.TCPAddr)
	return tcpAddr.IP.String(), tcpAddr.Port
}

func (s *smtpRecorder) serve() {
	for {
		conn, err := s.listener.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *smtpRecorder) handle(conn net.Conn) {
	defer conn.Close()
	r := bufio.NewReader(conn)
	write := func(format string, args ...interface{}) {
		fmt.Fprintf(conn, format+"\r\n", args...)
	}

	write("220 test.local ESMTP ready")
	inData := false
	var body strings.Builder
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		line = strings.TrimRight(line, "\r\n")

		if inData {
			if line == "." {
				inData = false
				s.mu.Lock()
				s.data = body.String()
				s.mu.Unlock()
				write("250 2.0.0 Ok: queued")
				select {
				case <-s.done:
				default:
					close(s.done)
				}
				continue
			}
			body.WriteString(line + "\n")
			continue
		}

		verb := strings.ToUpper(line)
		switch {
		case strings.HasPrefix(verb, "EHLO"):
			write("250-test.local")
			write("250 SIZE 10240000")
		case strings.HasPrefix(verb, "HELO"):
			write("250 test.local")
		case strings.HasPrefix(verb, "MAIL FROM"):
			write("250 2.1.0 Ok")
		case strings.HasPrefix(verb, "RCPT TO"):
			if start := strings.Index(line, "<"); start >= 0 {
				if end := strings.Index(line[start:], ">"); end > 0 {
					s.mu.Lock()
					s.recipients = append(s.recipients, line[start+1:start+end])
					s.mu.Unlock()
				}
			}
			write("250 2.1.5 Ok")
		case verb == "DATA":
			inData = true
			write("354 End data with <CR><LF>.<CR><LF>")
		case verb == "QUIT":
			write("221 2.0.0 Bye")
			return
		default:
			write("250 2.0.0 Ok")
		}
	}
}

func (s *smtpRecorder) waitForMessage(t *testing.T) (recipients []string, data string) {
	t.Helper()
	select {
	case <-s.done:
	case <-time.After(5 * time.Second):
		t.Fatal("timed out waiting for the SMTP message")
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.recipients, s.data
}

func newAuthService(t *testing.T, users []*models.User) *auth.Service {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "notify.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	svc := auth.NewService(db, "test-secret", slog.Default())
	for _, u := range users {
		if u.CreatedAt.IsZero() {
			u.CreatedAt = time.Now()
			u.UpdatedAt = u.CreatedAt
		}
		if err := svc.CreateUser(context.Background(), u); err != nil {
			t.Fatalf("create user %s: %v", u.Username, err)
		}
	}
	return svc
}

func useTestConfig(t *testing.T, notifyEnabled bool) {
	t.Helper()
	orig := config.Get()
	cfg := &config.Config{}
	cfg.Notify.Enabled = notifyEnabled
	cfg.Logging.Path = filepath.Join(t.TempDir(), "libreserv.log")
	config.SetTestConfig(cfg)
	t.Cleanup(func() { config.SetTestConfig(orig) })
}

func TestService_AdminNotify_SendsHTMLToAdminsWithEmail(t *testing.T) {
	useTestConfig(t, true)
	srv := newSMTPRecorder(t)
	host, port := srv.addr()

	sender, err := email.NewSenderWithConfig(config.SMTPConfig{
		Host: host,
		Port: port,
		From: "no-reply@example.com",
	})
	if err != nil {
		t.Fatalf("NewSenderWithConfig: %v", err)
	}

	authSvc := newAuthService(t, []*models.User{
		{ID: "1", Username: "admin1", Email: "admin1@example.com", Role: "admin"},
		{ID: "2", Username: "admin2", Email: "", Role: "admin"},
		{ID: "3", Username: "user", Email: "user@example.com", Role: "user"},
	})

	svc := NewService(authSvc, sender)
	if err := svc.AdminNotify(context.Background(), "Disk almost full", "Free space is low."); err != nil {
		t.Fatalf("AdminNotify: %v", err)
	}

	recipients, data := srv.waitForMessage(t)
	if len(recipients) != 1 || recipients[0] != "admin1@example.com" {
		t.Errorf("recipients = %v, want only admin1@example.com (admins without an email and non-admins are skipped)", recipients)
	}
	if !strings.Contains(data, "Subject: Disk almost full") {
		t.Errorf("message is missing the subject header:\n%s", data)
	}
	if !strings.Contains(data, "text/html") {
		t.Errorf("message is not an HTML email:\n%s", data)
	}
}

func TestService_AdminNotify_NoSenderIsNoop(t *testing.T) {
	useTestConfig(t, true)
	svc := NewService(newAuthService(t, nil), nil)

	if err := svc.AdminNotify(context.Background(), "subject", "body"); err != nil {
		t.Fatalf("AdminNotify with no sender: %v", err)
	}
}

func TestService_AdminNotify_DisabledByConfig(t *testing.T) {
	useTestConfig(t, false)
	srv := newSMTPRecorder(t)
	host, port := srv.addr()
	sender, err := email.NewSenderWithConfig(config.SMTPConfig{Host: host, Port: port, From: "no-reply@example.com"})
	if err != nil {
		t.Fatalf("NewSenderWithConfig: %v", err)
	}

	authSvc := newAuthService(t, []*models.User{
		{ID: "1", Username: "admin1", Email: "admin1@example.com", Role: "admin"},
	})

	svc := NewService(authSvc, sender)
	if err := svc.AdminNotify(context.Background(), "subject", "body"); err != nil {
		t.Fatalf("AdminNotify: %v", err)
	}

	select {
	case <-srv.done:
		t.Fatal("a message was sent even though notifications are disabled")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestService_AdminNotify_NoAdminsWithEmail(t *testing.T) {
	useTestConfig(t, true)
	srv := newSMTPRecorder(t)
	host, port := srv.addr()
	sender, err := email.NewSenderWithConfig(config.SMTPConfig{Host: host, Port: port, From: "no-reply@example.com"})
	if err != nil {
		t.Fatalf("NewSenderWithConfig: %v", err)
	}

	authSvc := newAuthService(t, []*models.User{
		{ID: "1", Username: "user", Email: "user@example.com", Role: "user"},
	})

	svc := NewService(authSvc, sender)
	if err := svc.AdminNotify(context.Background(), "subject", "body"); err != nil {
		t.Fatalf("AdminNotify: %v", err)
	}

	select {
	case <-srv.done:
		t.Fatal("a message was sent even though there are no admins with an email address")
	case <-time.After(200 * time.Millisecond):
	}
}

func TestService_AdminNotifyWithData_SendFailurePropagates(t *testing.T) {
	useTestConfig(t, true)
	// Bind and immediately close a port so the sender has nowhere to connect.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	if err := ln.Close(); err != nil {
		t.Fatalf("close listener: %v", err)
	}

	sender, err := email.NewSenderWithConfig(config.SMTPConfig{Host: "127.0.0.1", Port: port, From: "no-reply@example.com"})
	if err != nil {
		t.Fatalf("NewSenderWithConfig: %v", err)
	}

	authSvc := newAuthService(t, []*models.User{
		{ID: "1", Username: "admin1", Email: "admin1@example.com", Role: "admin"},
	})

	svc := NewService(authSvc, sender)
	err = svc.AdminNotifyWithData(context.Background(), "subject", "body", map[string]interface{}{"AppName": "demo"})
	if err == nil {
		t.Fatal("AdminNotifyWithData = nil error, want the plaintext fallback failure")
	}
}

func TestService_SetSender(t *testing.T) {
	useTestConfig(t, true)
	authSvc := newAuthService(t, []*models.User{
		{ID: "1", Username: "admin1", Email: "admin1@example.com", Role: "admin"},
	})
	svc := NewService(authSvc, nil)

	srv := newSMTPRecorder(t)
	host, port := srv.addr()
	sender, err := email.NewSenderWithConfig(config.SMTPConfig{Host: host, Port: port, From: "no-reply@example.com"})
	if err != nil {
		t.Fatalf("NewSenderWithConfig: %v", err)
	}

	svc.SetSender(sender)
	if err := svc.AdminNotify(context.Background(), "subject", "body"); err != nil {
		t.Fatalf("AdminNotify after SetSender: %v", err)
	}
	if recipients, _ := srv.waitForMessage(t); len(recipients) != 1 {
		t.Errorf("recipients = %v, want one admin", recipients)
	}

	// nil disables notifications again.
	svc.SetSender(nil)
	if err := svc.AdminNotify(context.Background(), "subject", "body"); err != nil {
		t.Fatalf("AdminNotify with sender cleared: %v", err)
	}
}

func TestService_GetAdminEmails_DBError(t *testing.T) {
	useTestConfig(t, true)
	db, err := database.Open(filepath.Join(t.TempDir(), "notify.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("close db: %v", err)
	}

	srv := newSMTPRecorder(t)
	host, port := srv.addr()
	sender, err := email.NewSenderWithConfig(config.SMTPConfig{Host: host, Port: port, From: "no-reply@example.com"})
	if err != nil {
		t.Fatalf("NewSenderWithConfig: %v", err)
	}

	svc := NewService(auth.NewService(db, "test-secret", slog.Default()), sender)
	if err := svc.AdminNotify(context.Background(), "subject", "body"); err == nil {
		t.Fatal("AdminNotify = nil error, want the admin lookup failure")
	}
}
