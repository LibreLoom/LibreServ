package mail

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

// errMailHTTPRedirect refuses HTTP redirects. The Resend client carries an API
// key; following a 302 can send credentials or land on an unexpected host.
var errMailHTTPRedirect = fmt.Errorf("mail HTTP client does not follow redirects")

func defaultHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errMailHTTPRedirect
		},
	}
}

// Sender is server-only transactional mail (billing warnings). The web app
// never talks to Resend.
type Sender interface {
	Send(to, subject, text string) error
}

type Client struct {
	APIKey  string
	From    string
	BaseURL string
	HTTP    *http.Client
}

func New() *Client {
	from := strings.TrimSpace(config.C.Mail.From)
	if from == "" {
		from = "Luna Connect <noreply@connect.luna.libreloom.org>"
	}
	return &Client{
		APIKey:  strings.TrimSpace(config.C.Mail.ResendAPIKey),
		From:    from,
		BaseURL: strings.TrimSpace(config.C.Mail.BaseURL),
		HTTP:    defaultHTTPClient(),
	}
}

func (c *Client) Send(to, subject, text string) error {
	if c == nil {
		return nil
	}
	to = strings.TrimSpace(to)
	if to == "" {
		return nil
	}
	if strings.TrimSpace(c.APIKey) == "" {
		slog.Info("luna connect mail skipped", "to", to, "subject", subject)
		return nil
	}
	url := c.BaseURL
	if url == "" {
		url = "https://api.resend.com/emails"
	}
	body, _ := json.Marshal(map[string]any{
		"from":    c.From,
		"to":      []string{to},
		"subject": subject,
		"text":    text,
	})
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.APIKey)
	req.Header.Set("Content-Type", "application/json")
	res, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 300 {
		return fmt.Errorf("resend status %d", res.StatusCode)
	}
	return nil
}

// Recording is a test double.
type Recording struct {
	Sends [][3]string
}

func (r *Recording) Send(to, subject, text string) error {
	r.Sends = append(r.Sends, [3]string{to, subject, text})
	return nil
}
