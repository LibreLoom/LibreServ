package providers

import (
	"fmt"
	"net/http"
	"time"
)

// DNS is the Cloudflare DNS surface Name/Unregister use.
type DNS interface {
	UpsertCNAME(apiToken, zoneID, hostname, target string) error
	DeleteRecord(apiToken, zoneID, hostname string) error
}

type DNSClient struct {
	HTTP     *http.Client
	BaseURL  string
	MockMode bool
}

func NewDNSClient() *DNSClient {
	return &DNSClient{HTTP: &http.Client{Timeout: 15 * time.Second}}
}

func (c *DNSClient) api() string {
	if c.BaseURL != "" {
		return c.BaseURL
	}
	return "https://api.cloudflare.com/client/v4"
}

func (c *DNSClient) UpsertCNAME(apiToken, zoneID, hostname, target string) error {
	if c.MockMode {
		return nil
	}
	_ = c.DeleteRecord(apiToken, zoneID, hostname)
	url := fmt.Sprintf("%s/zones/%s/dns_records", c.api(), zoneID)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}
	body := map[string]any{
		"type": "CNAME", "name": hostname, "content": target, "ttl": 1, "proxied": true,
	}
	return doJSON(c.HTTP, http.MethodPost, url, headers, body, nil)
}

func (c *DNSClient) DeleteRecord(apiToken, zoneID, hostname string) error {
	if c.MockMode {
		return nil
	}
	listURL := fmt.Sprintf("%s/zones/%s/dns_records?name=%s", c.api(), zoneID, hostname)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}
	var list struct {
		Result []struct {
			ID string `json:"id"`
		} `json:"result"`
	}
	if err := doJSON(c.HTTP, http.MethodGet, listURL, headers, nil, &list); err != nil {
		return err
	}
	for _, rec := range list.Result {
		del := fmt.Sprintf("%s/zones/%s/dns_records/%s", c.api(), zoneID, rec.ID)
		_ = doJSON(c.HTTP, http.MethodDelete, del, headers, nil, nil)
	}
	return nil
}
