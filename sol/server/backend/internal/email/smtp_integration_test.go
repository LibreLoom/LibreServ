package email

import (
	"bufio"
	"bytes"
	"fmt"
	"net"
	"net/smtp"
	"net/textproto"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

type testSMTPServer struct {
	ln       net.Listener
	wg       sync.WaitGroup
	mu       sync.Mutex
	messages [][]byte
}

func startTestSMTPServer(t *testing.T) *testSMTPServer {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	s := &testSMTPServer{ln: ln}
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		for {
			conn, acceptErr := ln.Accept()
			if acceptErr != nil {
				return
			}
			s.wg.Add(1)
			go s.handle(conn)
		}
	}()
	t.Cleanup(func() {
		_ = ln.Close()
		s.wg.Wait()
	})
	return s
}

func (s *testSMTPServer) handle(conn net.Conn) {
	defer s.wg.Done()
	defer conn.Close()
	tp := textproto.NewConn(conn)
	defer tp.Close()
	_ = tp.PrintfLine("220 localhost test SMTP")
	for {
		line, err := tp.ReadLine()
		if err != nil {
			return
		}
		cmd := strings.ToUpper(line)
		switch {
		case strings.HasPrefix(cmd, "EHLO"):
			_ = tp.PrintfLine("250-localhost")
			_ = tp.PrintfLine("250-AUTH PLAIN")
			_ = tp.PrintfLine("250 OK")
		case strings.HasPrefix(cmd, "HELO"):
			_ = tp.PrintfLine("250 localhost")
		case strings.HasPrefix(cmd, "AUTH PLAIN"):
			_ = tp.PrintfLine("235 authenticated")
		case strings.HasPrefix(cmd, "MAIL FROM"), strings.HasPrefix(cmd, "RCPT TO"):
			_ = tp.PrintfLine("250 OK")
		case strings.HasPrefix(cmd, "DATA"):
			_ = tp.PrintfLine("354 send data")
			msg, readErr := tp.ReadDotBytes()
			if readErr != nil {
				return
			}
			s.mu.Lock()
			s.messages = append(s.messages, msg)
			s.mu.Unlock()
			_ = tp.PrintfLine("250 queued")
		case strings.HasPrefix(cmd, "QUIT"):
			_ = tp.PrintfLine("221 bye")
			return
		default:
			_ = tp.PrintfLine("250 OK")
		}
	}
}

func (s *testSMTPServer) config(username string) config.SMTPConfig {
	host, portString, _ := net.SplitHostPort(s.ln.Addr().String())
	port, _ := strconv.Atoi(portString)
	return config.SMTPConfig{
		Host:     host,
		Port:     port,
		Username: username,
		Password: "secret",
		From:     "sender@example.com",
	}
}

func (s *testSMTPServer) messageCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.messages)
}

func TestPlainSMTPHealthAndSending(t *testing.T) {
	server := startTestSMTPServer(t)
	cfg := server.config("smtp-user")
	original := config.Get()
	t.Cleanup(func() { config.SetTestConfig(original) })
	config.SetTestConfig(&config.Config{SMTP: cfg})

	if err := HealthCheck(); err != nil {
		t.Fatalf("health check: %v", err)
	}
	if err := TestSMTP(cfg); err != nil {
		t.Fatalf("test SMTP: %v", err)
	}
	sender, err := NewSender()
	if err != nil {
		t.Fatalf("new sender: %v", err)
	}
	if sender.makeAuth() == nil {
		t.Fatal("configured sender should use auth")
	}
	if err := sender.Send([]string{"one@example.com", "two@example.com"}, "Subject", "plain body"); err != nil {
		t.Fatalf("send plain: %v", err)
	}
	if err := sender.SendRaw([]string{"raw@example.com"}, "override@example.com", "Subject: Raw\r\n\r\nraw body"); err != nil {
		t.Fatalf("send raw: %v", err)
	}
	if err := sender.SendHTMLEmail([]string{"html@example.com"}, "HTML", "<strong>body</strong>"); err != nil {
		t.Fatalf("send HTML: %v", err)
	}
	if server.messageCount() != 3 {
		t.Fatalf("messages = %d, want 3", server.messageCount())
	}

	noAuth, err := NewSenderWithConfig(server.config(""))
	if err != nil || noAuth.makeAuth() != nil {
		t.Fatalf("no-auth sender = %#v, %v", noAuth, err)
	}
}

func TestSMTPValidationAndConnectionErrors(t *testing.T) {
	original := config.Get()
	t.Cleanup(func() { config.SetTestConfig(original) })
	config.SetTestConfig(nil)
	if _, err := NewSender(); err == nil || !strings.Contains(err.Error(), "config not loaded") {
		t.Fatalf("NewSender error = %v", err)
	}
	config.SetTestConfig(&config.Config{})
	if _, err := NewSender(); err == nil || !strings.Contains(err.Error(), "smtp not configured") {
		t.Fatalf("unconfigured sender error = %v", err)
	}
	if err := HealthCheck(); err == nil || !strings.Contains(err.Error(), "smtp not configured") {
		t.Fatalf("health error = %v", err)
	}
	if err := TestSMTP(config.SMTPConfig{}); err == nil || !strings.Contains(err.Error(), "host required") {
		t.Fatalf("test config error = %v", err)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	host, portString, _ := net.SplitHostPort(addr)
	port, _ := strconv.Atoi(portString)
	bad := config.SMTPConfig{Host: host, Port: port, From: "a@example.com"}
	if err := TestSMTP(bad); err == nil {
		t.Fatal("expected connection error")
	}
	config.SetTestConfig(&config.Config{SMTP: bad})
	if err := HealthCheck(); err == nil {
		t.Fatal("expected health connection error")
	}
	sender, _ := NewSenderWithConfig(bad)
	if err := sender.Send([]string{"a@example.com"}, "x", "y"); err == nil {
		t.Fatal("expected send connection error")
	}
	if err := sender.SendRaw(nil, "a@example.com", "x"); err == nil {
		t.Fatal("expected SendRaw recipients error")
	}
	if err := sender.SendHTMLEmail(nil, "x", "y"); err == nil {
		t.Fatal("expected HTML recipients error")
	}
}

func TestSMTPAuthAndSkipVerifyHelpers(t *testing.T) {
	if authFor("", "", "localhost", false) != nil {
		t.Fatal("empty username should not create auth")
	}
	auth := &plainAuth{username: "u", password: "p"}
	mechanism, response, err := auth.Start(&smtp.ServerInfo{})
	if err != nil || mechanism != "PLAIN" || !bytes.Equal(response, []byte("\x00u\x00p")) {
		t.Fatalf("auth start = %q, %q, %v", mechanism, response, err)
	}
	if response, err := auth.Next(nil, false); err != nil || response != nil {
		t.Fatalf("auth next complete = %q, %v", response, err)
	}
	if _, err := auth.Next(nil, true); err == nil {
		t.Fatal("expected challenge error")
	}

	original := config.Get()
	t.Cleanup(func() { config.SetTestConfig(original) })
	if resolveSkipVerify(false) {
		t.Fatal("false skip verify changed")
	}
	t.Setenv("LIBRESERV_INSECURE_DEV", "")
	if resolveSkipVerify(true) {
		t.Fatal("skip verify should require development opt-in")
	}
	t.Setenv("LIBRESERV_INSECURE_DEV", "true")
	config.SetTestConfig(&config.Config{Server: config.ServerConfig{Mode: "production"}})
	if resolveSkipVerify(true) {
		t.Fatal("production skip verify should be rejected")
	}
	config.SetTestConfig(&config.Config{Server: config.ServerConfig{Mode: "development"}})
	if !resolveSkipVerify(true) {
		t.Fatal("development skip verify should be allowed")
	}

	for host, want := range map[string]int{"smtp.example.com:587": 587, "invalid": 0, "smtp.example.com:nope": 0} {
		if got := (&Sender{host: host}).port(); got != want {
			t.Errorf("port(%q) = %d, want %d", host, got, want)
		}
	}
}

func TestRelayConnectionCommands(t *testing.T) {
	relay := NewRelay()
	serverConn, clientConn := net.Pipe()
	relay.wg.Add(1)
	go relay.handleConn(serverConn)

	reader := bufio.NewReader(clientConn)
	readLine := func(want string) {
		t.Helper()
		_ = clientConn.SetReadDeadline(time.Now().Add(time.Second))
		line, err := reader.ReadString('\n')
		if err != nil || !strings.Contains(line, want) {
			t.Fatalf("line = %q, %v, want %q", line, err, want)
		}
	}
	send := func(command string) {
		t.Helper()
		_, _ = fmt.Fprintf(clientConn, "%s\r\n", command)
	}

	readLine("220")
	send("EHLO test")
	readLine("250-localhost")
	readLine("250 OK")
	send("AUTH PLAIN ignored")
	readLine("235")
	send("MAIL FROM:invalid")
	readLine("501")
	send("MAIL FROM:<from@example.com>")
	readLine("250")
	send("RCPT TO:invalid")
	readLine("501")
	send("RCPT TO:<to@example.com>")
	readLine("250")
	send("RSET")
	readLine("250")
	send("NOOP")
	readLine("250")
	send("UNKNOWN")
	readLine("500")
	send("QUIT")
	readLine("221")
	_ = clientConn.Close()
	relay.wg.Wait()
}

func TestRelayDataPaths(t *testing.T) {
	original := config.Get()
	t.Cleanup(func() { config.SetTestConfig(original) })

	run := func(relay *Relay, cfg *config.Config, rcpts []string, input string) string {
		t.Helper()
		config.SetTestConfig(cfg)
		var output strings.Builder
		session := &relaySession{
			relay: relay,
			tp:    textproto.NewReader(bufio.NewReader(strings.NewReader(input))),
			w:     &output,
			from:  "from@example.com",
			rcpts: rcpts,
		}
		session.handleData()
		return output.String()
	}

	if got := run(NewRelay(), nil, nil, ""); !strings.Contains(got, "503") {
		t.Fatalf("missing recipient response = %q", got)
	}
	if got := run(NewRelay(), &config.Config{}, []string{"to@example.com"}, ""); !strings.Contains(got, "421") {
		t.Fatalf("unconfigured response = %q", got)
	}

	self := &Relay{listenPort: 2525}
	selfCfg := &config.Config{SMTP: config.SMTPConfig{Host: " localhost ", Port: 2525, From: "a@example.com"}}
	if got := run(self, selfCfg, []string{"to@example.com"}, ".\r\n"); !strings.Contains(got, "550") ||
		!strings.Contains(got, "loop forever") {
		t.Fatalf("self-forward response = %q", got)
	}

	upstream := startTestSMTPServer(t)
	goodCfg := &config.Config{SMTP: upstream.config("")}
	if got := run(NewRelay(), goodCfg, []string{"to@example.com"}, "Subject: x\r\n\r\n..dot\r\n.\r\n"); !strings.Contains(got, "250 OK") {
		t.Fatalf("success response = %q", got)
	}
	if upstream.messageCount() != 1 {
		t.Fatalf("forwarded messages = %d", upstream.messageCount())
	}

	missingFrom := &config.Config{SMTP: upstream.config("")}
	missingFrom.SMTP.From = ""
	if got := run(NewRelay(), missingFrom, []string{"to@example.com"}, ".\r\n"); !strings.Contains(got, "421") {
		t.Fatalf("invalid upstream response = %q", got)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	host, portString, _ := net.SplitHostPort(ln.Addr().String())
	port, _ := strconv.Atoi(portString)
	_ = ln.Close()
	failedCfg := &config.Config{SMTP: config.SMTPConfig{Host: host, Port: port, From: "a@example.com"}}
	if got := run(NewRelay(), failedCfg, []string{"to@example.com"}, ".\r\n"); !strings.Contains(got, "550 could not send email") {
		t.Fatalf("failed forward response = %q", got)
	}

	config.SetTestConfig(goodCfg)
	got := NewRelay().readUpstream()
	if got.host != goodCfg.SMTP.Host || got.port != goodCfg.SMTP.Port || got.from != goodCfg.SMTP.From {
		t.Fatalf("upstream = %+v", got)
	}
	for line, want := range map[string]string{
		"MAIL FROM:<a@example.com>": "a@example.com",
		"MAIL FROM:a@example.com":   "",
		"broken > before <":         "",
	} {
		if got := extractAngleAddr(line); got != want {
			t.Errorf("extractAngleAddr(%q) = %q, want %q", line, got, want)
		}
	}
}

func TestEmailTemplateAndHTMLHelpers(t *testing.T) {
	if tmpl, err := GetTemplate("welcome"); err != nil || tmpl.Key != "welcome" {
		t.Fatalf("template = %+v, %v", tmpl, err)
	}
	if _, err := GetTemplate("missing"); err == nil {
		t.Fatal("expected missing template error")
	}
	subject, body, err := RenderTemplateByKey("welcome", map[string]any{"Username": "Alice"})
	if err != nil || !strings.Contains(subject, "Welcome") || !strings.Contains(body, "Alice") {
		t.Fatalf("rendered template = %q, %q, %v", subject, body, err)
	}
	if _, _, err := RenderTemplateByKey("missing", nil); err == nil {
		t.Fatal("expected missing keyed template error")
	}

	for line, want := range map[string]string{
		"reset at https://example.com/reset":  "Reset Password",
		"verify https://example.com/confirm":  "Confirm",
		"sign in https://example.com/login":   "Sign In",
		"visit https://example.com/dashboard": "Open",
		"there is no link in this line":       "Open",
	} {
		if got := inferButtonLabel(line, extractURL(line)); got != want {
			t.Errorf("button label for %q = %q, want %q", line, got, want)
		}
	}
	if extractURL("prefix https://example.com/path suffix") != "https://example.com/path" {
		t.Fatal("URL extraction failed")
	}
	if extractURL("nothing") != "" {
		t.Fatal("unexpected URL")
	}
	html := convertTextToHTML("Hello <Alice>\nsecond line\n\nOpen https://example.com")
	if !strings.Contains(html, "&lt;Alice&gt;") || !strings.Contains(html, "<a href=") {
		t.Fatalf("converted HTML = %s", html)
	}
	if got := renderLine("<unsafe>"); !strings.Contains(got, "&lt;unsafe&gt;") {
		t.Fatalf("rendered line = %s", got)
	}
	if got := renderParagraph("one\ntwo"); !strings.Contains(got, "&lt;br&gt;") {
		t.Fatalf("rendered paragraph = %s", got)
	}
	if !containsURL("http://example.com") || containsURL("example.com") {
		t.Fatal("URL detection failed")
	}

	sender := &Sender{}
	message := sender.buildHTMLMessage(
		"from@example.com\r\nBcc: evil@example.com",
		[]string{"to@example.com\nCc: evil@example.com"},
		"safe\r\nInjected: yes",
		"<p>body</p>",
	)
	if strings.Contains(message, "\r\nBcc:") || strings.Contains(message, "\nCc:") || strings.Contains(message, "\nInjected:") {
		t.Fatalf("header injection survived: %q", message)
	}
	if !strings.Contains(message, "\r\n\r\n<p>body</p>") {
		t.Fatalf("HTML body separator missing: %q", message)
	}
}
