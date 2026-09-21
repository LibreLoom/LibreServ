package mail

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

func TestNewDefaultsFrom(t *testing.T) {
	orig := config.C.Mail
	t.Cleanup(func() { config.C.Mail = orig })
	config.C.Mail = config.MailConfig{}
	c := New()
	if !strings.Contains(c.From, "Luna Connect") {
		t.Fatalf("default From = %q", c.From)
	}
}

func TestSendSkipsWithoutAPIKey(t *testing.T) {
	var nilClient *Client
	if err := nilClient.Send("a@b.com", "hi", "body"); err != nil {
		t.Fatalf("nil client: %v", err)
	}
	c := &Client{}
	if err := c.Send("", "hi", "body"); err != nil {
		t.Fatalf("empty to: %v", err)
	}
	if err := c.Send("a@b.com", "hi", "body"); err != nil {
		t.Fatalf("empty API key should skip: %v", err)
	}
}

func TestSendOKAndHTTPError(t *testing.T) {
	var sawAuth string
	okSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		body, _ := io.ReadAll(r.Body)
		if !strings.Contains(string(body), "hello") {
			t.Errorf("body = %s", body)
		}
		w.WriteHeader(http.StatusOK)
	}))
	t.Cleanup(okSrv.Close)

	c := &Client{APIKey: "re_test", From: "from@x", BaseURL: okSrv.URL, HTTP: okSrv.Client()}
	if err := c.Send("to@x", "subj", "hello"); err != nil {
		t.Fatalf("Send OK: %v", err)
	}
	if sawAuth != "Bearer re_test" {
		t.Fatalf("auth = %q", sawAuth)
	}

	errSrv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
	}))
	t.Cleanup(errSrv.Close)
	c.BaseURL = errSrv.URL
	c.HTTP = errSrv.Client()
	if err := c.Send("to@x", "subj", "hello"); err == nil {
		t.Fatal("expected HTTP error")
	}
}

func TestRecordingSend(t *testing.T) {
	r := &Recording{}
	if err := r.Send("a@b.com", "s", "t"); err != nil {
		t.Fatal(err)
	}
	if len(r.Sends) != 1 || r.Sends[0][0] != "a@b.com" {
		t.Fatalf("Sends = %#v", r.Sends)
	}
}
