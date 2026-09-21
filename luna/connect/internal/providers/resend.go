package providers

import (
	"fmt"
	"net/http"
	"time"
)

// ResendClient talks to the Resend API for transactional email.
type ResendClient struct {
	httpClient *http.Client
	baseURL    string
}

// NewResendClient creates a Resend client with the given HTTP client or a default 15s timeout.
func NewResendClient(httpClient *http.Client) *ResendClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	return &ResendClient{httpClient: httpClient}
}

// NewResendClientWithBaseURL points the client at a custom base URL (tests / mocks).
func NewResendClientWithBaseURL(httpClient *http.Client, baseURL string) *ResendClient {
	c := NewResendClient(httpClient)
	c.baseURL = baseURL
	return c
}

type resendSendResponse struct {
	ID string `json:"id"`
}

// SendEmail sends an email through Resend's REST API. Pass htmlBody or textBody
// (or both); empty ones are omitted. The from address should be a verified
// domain in the Resend account.
func (c *ResendClient) SendEmail(apiKey, from, to, subject, htmlBody, textBody string) error {
	url := c.baseURL
	if url == "" {
		url = "https://api.resend.com/emails"
	}
	body := map[string]string{
		"from":    from,
		"to":      to,
		"subject": subject,
	}
	if htmlBody != "" {
		body["html"] = htmlBody
	}
	if textBody != "" {
		body["text"] = textBody
	}
	var resp resendSendResponse
	if err := doJSON(c.httpClient, http.MethodPost, url, map[string]string{
		"Authorization": "Bearer " + apiKey,
	}, body, &resp); err != nil {
		return fmt.Errorf("could not send email via Resend: %w", err)
	}
	return nil
}
