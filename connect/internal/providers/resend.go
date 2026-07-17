package providers

import (
	"fmt"
	"net/http"
	"time"
)

// ResendSMTP holds the values a device needs to send mail through Resend.
type ResendSMTP struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
}

// ResendClient talks to the Resend API.
type ResendClient struct {
	httpClient *http.Client
	baseURL    string
}

// NewResendClient creates a Resend client with the given HTTP client or a default 15s timeout client.
func NewResendClient(httpClient *http.Client) *ResendClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	return &ResendClient{httpClient: httpClient}
}

// resendAPIKeyResponse is the body returned by Resend when creating an API key.
type resendAPIKeyResponse struct {
	ID    string `json:"id"`
	Token string `json:"token"`
	Name  string `json:"name"`
}

// CreateAPIKey creates a new Resend API key with sending access only.
func (c *ResendClient) CreateAPIKey(apiKey, name string) (*ResendSMTP, error) {
	if name == "" {
		name = "libreserv-device"
	}
	url := c.baseURL
	if url == "" {
		url = "https://api.resend.com/api-keys"
	}
	var resp resendAPIKeyResponse
	if _, err := doJSON(c.httpClient, http.MethodPost, url, map[string]string{
		"Authorization": "Bearer " + apiKey,
	}, map[string]string{
		"name":       name,
		"permission": "sending_access",
	}, &resp); err != nil {
		return nil, fmt.Errorf("could not create Resend API key: %w", err)
	}

	return &ResendSMTP{
		Host:     "smtp.resend.com",
		Port:     587,
		Username: "resend",
		Password: resp.Token,
	}, nil
}
