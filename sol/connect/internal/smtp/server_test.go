package smtp

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/smtp"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/providers"
)

// capturedSend is one request body the mock Resend API received.
type capturedSend struct {
	From    string
	To      string
	Subject string
	HTML    string
	Text    string
}

func TestRelayForwardsCleanTextBody(t *testing.T) {
	runRelayTest(t, "text/plain", func(send capturedSend) {
		body := "Your sign-in code is 753414 and it expires in 10 minutes."
		if send.Subject != "Your sign-in code" {
			t.Errorf("subject = %q, want %q", send.Subject, "Your sign-in code")
		}
		if got := strings.TrimRight(send.Text, "\r\n"); got != body {
			t.Errorf("text body = %q, want %q (body only, no header dump)", send.Text, body)
		}
		for _, hdr := range []string{"From:", "Subject:", "MIME-Version:", "Content-Type:"} {
			if strings.Contains(send.Text, hdr) {
				t.Errorf("text body contains raw header %q — body is not byte-clean", hdr)
			}
		}
		if send.HTML != "" {
			t.Errorf("html = %q, want empty for text/plain message", send.HTML)
		}
	})
}

func TestRelayForwardsHTMLBody(t *testing.T) {
	runRelayTest(t, "text/html", func(send capturedSend) {
		body := "<p>Your sign-in code is <b>753414</b> and it expires in 10 minutes.</p>"
		if send.Subject != "Your sign-in code" {
			t.Errorf("subject = %q, want %q", send.Subject, "Your sign-in code")
		}
		if got := strings.TrimRight(send.HTML, "\r\n"); got != body {
			t.Errorf("html body = %q, want %q (body only, no header dump)", send.HTML, body)
		}
		if send.Text != "" {
			t.Errorf("text = %q, want empty for text/html message", send.Text)
		}
	})
}

// runRelayTest builds the full harness (real Postgres account + real SMTP
// server on an OS-assigned 127.0.0.1 port + mock Resend API), sends one
// message with the given Content-Type, then asserts on the captured payload.
func runRelayTest(t *testing.T, contentType string, assert func(send capturedSend)) {
	t.Helper()

	db := database.OpenTestDB(t)
	if db == nil {
		return // skipped
	}
	t.Cleanup(func() { db.Close() })

	// Register a customer account so the relay can authenticate.
	const username = "relaytest"
	const smtpPassword = "correct-horse-battery"
	if _, err := db.Exec(
		`INSERT INTO customer_accounts (id, email, password_hash, name, plan_id, email_verified, username, smtp_password)
		 VALUES ('acct-relay-1', 'relaytest@example.com', 'x', 'Relay Test', 'free', TRUE, 'relaytest', 'correct-horse-battery')`); err != nil {
		t.Fatalf("insert account: %v", err)
	}

	// Mock Resend API — capture what the relay forwards.
	var captured []capturedSend
	resendMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/emails" {
			http.NotFound(w, r)
			return
		}
		var send struct {
			From    string `json:"from"`
			To      string `json:"to"`
			Subject string `json:"subject"`
			HTML    string `json:"html"`
			Text    string `json:"text"`
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &send); err != nil {
			t.Errorf("decode relayed payload: %v", err)
		}
		captured = append(captured, capturedSend{
			From:    send.From,
			To:      send.To,
			Subject: send.Subject,
			HTML:    send.HTML,
			Text:    send.Text,
		})
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"id":"mock-1"}`)
	}))
	defer resendMock.Close()

	// Start reads the listen address from global config — point it at an
	// OS-assigned 127.0.0.1 port (dev safety: never a fixed port).
	configRelayAddr := config.C.SMTP.RelayAddr
	config.C.SMTP.RelayAddr = "127.0.0.1:0"
	t.Cleanup(func() { config.C.SMTP.RelayAddr = configRelayAddr })

	client := providers.NewResendClientWithBaseURL(resendMock.Client(), resendMock.URL+"/emails")
	srv := NewServer(db, client, func() string { return "re_mock_test" })
	if err := srv.Start(); err != nil {
		t.Fatalf("start relay: %v", err)
	}
	t.Cleanup(srv.Stop)

	addr := srv.listener.Addr().String()
	if !strings.HasPrefix(addr, "127.0.0.1:") {
		t.Fatalf("relay bound on %q, want 127.0.0.1", addr)
	}

	// Drive a real SMTP transaction.
	from := SendingAddress(username)
	msg := "From: Device <device@example.com>\r\n" +
		"To: " + from + "\r\n" +
		"Subject: Your sign-in code\r\n" +
		"MIME-Version: 1.0\r\n" +
		"Content-Type: " + contentType + "\r\n" +
		"\r\n" +
		bodyFor(contentType)
	if err := smtp.SendMail(addr, smtp.PlainAuth("", username, smtpPassword, "127.0.0.1"), from, []string{"recipient@example.com"}, []byte(msg)); err != nil {
		t.Fatalf("send mail: %v", err)
	}

	if len(captured) != 1 {
		t.Fatalf("relay forwarded %d sends, want 1", len(captured))
	}
	send := captured[0]
	if send.From != SendingAddress(username) {
		t.Errorf("from = %q, want %q", send.From, from)
	}
	if send.To != "recipient@example.com" {
		t.Errorf("to = %q, want envelope recipient", send.To)
	}
	assert(send)
}

func bodyFor(contentType string) string {
	if strings.HasPrefix(contentType, "text/html") {
		return "<p>Your sign-in code is <b>753414</b> and it expires in 10 minutes.</p>\r\n"
	}
	return "Your sign-in code is 753414 and it expires in 10 minutes.\r\n"
}
