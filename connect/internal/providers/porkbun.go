package providers

import (
	"fmt"
	"net/http"
	"time"
)

// PorkbunClient talks to the Porkbun DNS API.
type PorkbunClient struct {
	httpClient *http.Client
	baseURL    string
}

// NewPorkbunClient creates a Porkbun client with the given HTTP client or a default 15s timeout client.
func NewPorkbunClient(httpClient *http.Client) *PorkbunClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	return &PorkbunClient{httpClient: httpClient}
}

// porkbunCreateRecordRequest is the body sent to create a DNS record.
type porkbunCreateRecordRequest struct {
	APIKey    string `json:"apikey"`
	SecretKey string `json:"secretapikey"`
	Name      string `json:"name"`
	Type      string `json:"type"`
	Content   string `json:"content"`
	TTL       int    `json:"ttl,omitempty"`
}

// CreateRecord creates a DNS record on Porkbun. Returns a flag indicating whether the zone is managed here.
func (c *PorkbunClient) CreateRecord(apiKey, secretKey, zone, name, recordType, content string, ttl int) (bool, error) {
	if apiKey == "" || secretKey == "" {
		return false, fmt.Errorf("Porkbun API credentials are not configured")
	}
	if zone == "" {
		return false, fmt.Errorf("DNS zone is not configured")
	}

	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://porkbun.com/api/json/v3"
	}
	url := fmt.Sprintf("%s/dns/create/%s", baseURL, zone)
	body := porkbunCreateRecordRequest{
		APIKey:    apiKey,
		SecretKey: secretKey,
		Name:      name,
		Type:      recordType,
		Content:   content,
	}
	if ttl > 0 {
		body.TTL = ttl
	}

	if _, err := doJSON(c.httpClient, http.MethodPost, url, nil, body, nil); err != nil {
		return false, fmt.Errorf("could not create DNS record at Porkbun: %w", err)
	}
	return true, nil
}
