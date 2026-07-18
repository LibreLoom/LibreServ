package providers

import (
	"fmt"
	"net/http"
	"time"
)

// CloudflareClient talks to the Cloudflare DNS API.
type CloudflareClient struct {
	httpClient *http.Client
	baseURL    string
}

// NewCloudflareClient creates a Cloudflare client with the given HTTP client or a default 15s timeout client.
func NewCloudflareClient(httpClient *http.Client) *CloudflareClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	return &CloudflareClient{httpClient: httpClient}
}

// cloudflareCreateRecordRequest is the body sent to create a DNS record.
type cloudflareCreateRecordRequest struct {
	Type    string `json:"type"`
	Name    string `json:"name"`
	Content string `json:"content"`
	TTL     int    `json:"ttl"`
	Proxied bool   `json:"proxied"`
}

// cloudflareZoneResponse is the response from the Cloudflare zones API.
type cloudflareZoneResponse struct {
	Result []struct {
		ID   string `json:"id"`
		Name string `json:"name"`
	} `json:"result"`
	Success bool `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
}

// cloudflareRecordResponse is the response from creating a DNS record.
// The result is a single object, not an array.
type cloudflareRecordResponse struct {
	Result  map[string]any `json:"result"`
	Success bool           `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
}

// CreateRecord creates a DNS A record on Cloudflare. The zoneID is looked up
// from the zone name if not already known. Returns true if the record was created.
//
// Cloudflare uses a single API token (Bearer auth), not a key+secret pair.
// The record name is the full hostname (e.g. "myserver.example.com").
func (c *CloudflareClient) CreateRecord(apiToken, _ /* secretKey unused */, zone, name, recordType, content string, ttl int) (bool, error) {
	if apiToken == "" {
		return false, fmt.Errorf("Cloudflare API token is not configured")
	}
	if zone == "" {
		return false, fmt.Errorf("DNS zone is not configured")
	}

	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.cloudflare.com/client/v4"
	}

	// Look up the zone ID from the zone name.
	zoneID, err := c.lookupZoneID(baseURL, apiToken, zone)
	if err != nil {
		return false, fmt.Errorf("could not find Cloudflare zone %q: %w", zone, err)
	}

	// Build the full record name. Cloudflare expects the full hostname.
	recordName := name
	if !isFullHostname(name) {
		recordName = name + "." + zone
	}

	body := cloudflareCreateRecordRequest{
		Type:    recordType,
		Name:    recordName,
		Content: content,
		TTL:     1, // 1 = automatic; use explicit TTL if provided
		Proxied: false,
	}
	if ttl > 0 {
		body.TTL = ttl
	}

	url := fmt.Sprintf("%s/zones/%s/dns_records", baseURL, zoneID)
	headers := map[string]string{
		"Authorization": "Bearer " + apiToken,
	}

	var resp cloudflareRecordResponse
	if _, err := doJSON(c.httpClient, http.MethodPost, url, headers, body, &resp); err != nil {
		return false, fmt.Errorf("could not create DNS record at Cloudflare: %w", err)
	}
	if !resp.Success && len(resp.Errors) > 0 {
		return false, fmt.Errorf("Cloudflare API error: %s", resp.Errors[0].Message)
	}
	return true, nil
}

// lookupZoneID finds the Cloudflare zone ID for a given zone name.
func (c *CloudflareClient) lookupZoneID(baseURL, apiToken, zoneName string) (string, error) {
	url := fmt.Sprintf("%s/zones?name=%s", baseURL, zoneName)
	headers := map[string]string{
		"Authorization": "Bearer " + apiToken,
	}

	var resp cloudflareZoneResponse
	if _, err := doJSON(c.httpClient, http.MethodGet, url, headers, nil, &resp); err != nil {
		return "", fmt.Errorf("could not query Cloudflare zones: %w", err)
	}
	if !resp.Success {
		if len(resp.Errors) > 0 {
			return "", fmt.Errorf("Cloudflare API error: %s", resp.Errors[0].Message)
		}
		return "", fmt.Errorf("Cloudflare API returned no zones")
	}
	if len(resp.Result) == 0 {
		return "", fmt.Errorf("zone %q not found in Cloudflare account", zoneName)
	}
	return resp.Result[0].ID, nil
}

// isFullHostname returns true if the name looks like a full hostname (contains a dot).
func isFullHostname(name string) bool {
	for _, c := range name {
		if c == '.' {
			return true
		}
	}
	return false
}
