package email

import (
	"bufio"
	"fmt"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

type smtpTestServer struct {
	listener net.Listener
	wg       sync.WaitGroup
	mu       sync.Mutex
	messages []string
	auth     bool
}

func startSMTPTestServer(t *testing.T, advertiseAuth bool) *smtpTestServer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s := &smtpTestServer{listener: ln, auth: advertiseAuth}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			conn, err := ln.Accept()
			if err != nil {
				return
			}
			s.wg.Add(1)
			go s.serve(conn)
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		s.wg.Wait()
	})
	return s
}

func (s *smtpTestServer) addrParts(t *testing.T) (string, int) {
	t.Helper()
	host, portText, err := net.SplitHostPort(s.listener.Addr().String())
	if err != nil {
		t.Fatalf("split address: %v", err)
	}
	var port int
	if _, err := fmt.Sscanf(portText, "%d", &port); err != nil {
		t.Fatalf("parse port: %v", err)
	}
	return host, port
}

func (s *smtpTestServer) serve(conn net.Conn) {
	defer s.wg.Done()
	defer conn.Close()
	reader := bufio.NewReader(conn)
	writer := bufio.NewWriter(conn)
	write := func(line string) {
		_, _ = writer.WriteString(line + "\r\n")
		_ = writer.Flush()
	}
	write("220 smtp test ready")
	for {
		line, err := reader.ReadString('\n')
		if err != nil {
			return
		}
		command := strings.ToUpper(strings.TrimSpace(line))
		switch {
		case strings.HasPrefix(command, "EHLO"), strings.HasPrefix(command, "HELO"):
			if s.auth {
				_, _ = writer.WriteString("250-localhost\r\n250-AUTH PLAIN\r\n250 OK\r\n")
				_ = writer.Flush()
			} else {
				write("250 localhost")
			}
		case strings.HasPrefix(command, "AUTH"):
			write("235 authenticated")
		case strings.HasPrefix(command, "MAIL FROM"), strings.HasPrefix(command, "RCPT TO"):
			write("250 OK")
		case command == "DATA":
			write("354 send message")
			var message strings.Builder
			for {
				dataLine, readErr := reader.ReadString('\n')
				if readErr != nil {
					return
				}
				if dataLine == ".\r\n" || dataLine == ".\n" {
					break
				}
				message.WriteString(dataLine)
			}
			s.mu.Lock()
			s.messages = append(s.messages, message.String())
			s.mu.Unlock()
			write("250 queued")
		case command == "STARTTLS":
			write("500 TLS unavailable")
		case command == "QUIT":
			write("221 bye")
			return
		default:
			write("250 OK")
		}
	}
}

func (s *smtpTestServer) capturedMessages() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.messages...)
}

func TestNewSenderFromGlobalConfig(t *testing.T) {
	original := config.Get()
	t.Cleanup(func() { config.SetTestConfig(original) })
	config.SetTestConfig(nil)
	if _, err := NewSender(); err == nil || !strings.Contains(err.Error(), "config not loaded") {
		t.Fatalf("NewSender nil config error = %v", err)
	}
	config.SetTestConfig(&config.Config{SMTP: config.SMTPConfig{
		Host: "smtp.example.com", Port: 2525, From: "from@example.com",
	}})
	sender, err := NewSender()
	if err != nil || sender.host != "smtp.example.com:2525" {
		t.Fatalf("NewSender = %+v, %v", sender, err)
	}
}

func TestPlainSMTPDeliveryHealthAndConfigTest(t *testing.T) {
	server := startSMTPTestServer(t, true)
	host, port := server.addrParts(t)
	cfg := config.SMTPConfig{
		Host: host, Port: port, Username: "user", Password: "secret",
		From: "from@example.com", UseTLS: false,
	}
	sender, err := NewSenderWithConfig(cfg)
	if err != nil {
		t.Fatalf("NewSenderWithConfig: %v", err)
	}
	if sender.port() != port {
		t.Fatalf("port() = %d, want %d", sender.port(), port)
	}
	if sender.makeAuth() == nil {
		t.Fatal("expected configured auth")
	}
	if err := sender.Send([]string{"one@example.com", "two@example.com"}, "subject", "body"); err != nil {
		t.Fatalf("Send: %v", err)
	}
	raw := "From: other@example.com\r\nSubject: raw\r\n\r\nraw body"
	if err := sender.SendRaw([]string{"raw@example.com"}, "other@example.com", raw); err != nil {
		t.Fatalf("SendRaw: %v", err)
	}
	if err := TestSMTP(cfg); err != nil {
		t.Fatalf("TestSMTP: %v", err)
	}

	original := config.Get()
	t.Cleanup(func() { config.SetTestConfig(original) })
	config.SetTestConfig(&config.Config{SMTP: cfg})
	if err := HealthCheck(); err != nil {
		t.Fatalf("HealthCheck: %v", err)
	}

	deadline := time.Now().Add(time.Second)
	for len(server.capturedMessages()) < 2 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	messages := server.capturedMessages()
	if len(messages) != 2 || !strings.Contains(messages[0], "Subject: subject") ||
		!strings.Contains(messages[0], "\r\n\r\nbody") ||
		!strings.Contains(messages[1], "raw body") {
		t.Fatalf("captured messages = %#v", messages)
	}
}

func TestSMTPValidationAndConnectionFailures(t *testing.T) {
	if err := TestSMTP(config.SMTPConfig{}); err == nil || !strings.Contains(err.Error(), "host required") {
		t.Fatalf("missing host error = %v", err)
	}
	original := config.Get()
	t.Cleanup(func() { config.SetTestConfig(original) })
	config.SetTestConfig(&config.Config{})
	if err := HealthCheck(); err == nil || !strings.Contains(err.Error(), "not configured") {
		t.Fatalf("HealthCheck error = %v", err)
	}

	sender := &Sender{host: "127.0.0.1:1", from: "from@example.com"}
	if err := sender.Send([]string{"to@example.com"}, "subject", "body"); err == nil {
		t.Fatal("expected Send dial error")
	}
	if err := sender.SendRaw(nil, "from@example.com", "raw"); err == nil {
		t.Fatal("expected SendRaw missing recipient error")
	}
	if got := (&Sender{host: "invalid"}).port(); got != 0 {
		t.Fatalf("invalid port = %d", got)
	}
	if (&Sender{}).makeAuth() != nil {
		t.Fatal("empty username should disable auth")
	}

	server := startSMTPTestServer(t, false)
	host, port := server.addrParts(t)
	tlsCfg := config.SMTPConfig{Host: host, Port: port, From: "from@example.com", UseTLS: true}
	if err := TestSMTP(tlsCfg); err == nil {
		t.Fatal("expected STARTTLS rejection")
	}
}

func TestAuthHelpersAndHeaderSanitization(t *testing.T) {
	if authFor("", "", "localhost", false) != nil {
		t.Fatal("empty username should return nil auth")
	}
	auth := authFor("user", "secret", "example.com", false)
	mechanism, response, err := auth.Start(nil)
	if err != nil || mechanism != "PLAIN" || !strings.Contains(string(response), "user") {
		t.Fatalf("plain auth start = %q, %q, %v", mechanism, response, err)
	}
	if _, err := auth.Next(nil, true); err == nil {
		t.Fatal("expected unexpected challenge error")
	}
	if response, err := auth.Next(nil, false); err != nil || response != nil {
		t.Fatalf("plain auth completion = %q, %v", response, err)
	}
	if authFor("user", "secret", "localhost", true) == nil {
		t.Fatal("TLS auth should be configured")
	}

	msg := buildMessage(
		"from@example.com\r\nBcc: victim@example.com",
		[]string{"to@example.com\nCc: other@example.com"},
		"safe\r\nInjected: yes",
		"body",
	)
	if strings.Contains(msg, "\r\nBcc:") || strings.Contains(msg, "\nCc:") ||
		strings.Contains(msg, "\r\nInjected:") {
		t.Fatalf("header injection was not sanitized: %q", msg)
	}
	if got := sanitizeHeader("a\r\nb"); got != "ab" {
		t.Fatalf("sanitizeHeader = %q", got)
	}
}

func TestResolveSkipVerifyPolicy(t *testing.T) {
	original := config.Get()
	t.Cleanup(func() { config.SetTestConfig(original) })
	if resolveSkipVerify(false) {
		t.Fatal("false should remain false")
	}
	t.Setenv("LIBRESERV_INSECURE_DEV", "")
	config.SetTestConfig(&config.Config{Server: config.ServerConfig{Mode: "development"}})
	if resolveSkipVerify(true) {
		t.Fatal("skip verify should require explicit insecure development")
	}
	t.Setenv("LIBRESERV_INSECURE_DEV", "true")
	if !resolveSkipVerify(true) {
		t.Fatal("development opt-in should allow skip verify")
	}
	config.SetTestConfig(&config.Config{Server: config.ServerConfig{Mode: "production"}})
	if resolveSkipVerify(true) {
		t.Fatal("production must reject skip verify")
	}
}

func TestRenderTemplateErrors(t *testing.T) {
	if _, err := RenderTemplate("{{", nil); err == nil {
		t.Fatal("expected template parse error")
	}
	if _, err := RenderTemplate(`{{template "missing"}}`, nil); err == nil {
		t.Fatal("expected template execute error")
	}
}
