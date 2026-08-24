package providers

import (
	"fmt"
	"net/http"
	"time"
)

// Tunnel is the Cloudflare tunnel surface Name/Unregister use.
type Tunnel interface {
	CreateTunnel(accountID, apiToken, name string) (*TunnelCredentials, error)
	ConfigureIngress(accountID, apiToken, tunnelID, hostname, serviceURL string) error
	DeleteTunnel(accountID, apiToken, tunnelID string) error
}

type TunnelClient struct {
	HTTP     *http.Client
	BaseURL  string
	MockMode bool
}

type TunnelCredentials struct {
	TunnelID string
	Token    string
}

func NewTunnelClient() *TunnelClient {
	return &TunnelClient{HTTP: &http.Client{Timeout: 15 * time.Second}}
}

func (c *TunnelClient) api() string {
	if c.BaseURL != "" {
		return c.BaseURL
	}
	return "https://api.cloudflare.com/client/v4"
}

func (c *TunnelClient) CreateTunnel(accountID, apiToken, name string) (*TunnelCredentials, error) {
	if c.MockMode {
		return &TunnelCredentials{TunnelID: "mock-" + name, Token: "mock-token-" + name}, nil
	}
	url := fmt.Sprintf("%s/accounts/%s/cfd_tunnel", c.api(), accountID)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}
	body := map[string]string{"name": name, "config_src": "cloudflare"}
	var resp struct {
		Success bool `json:"success"`
		Result  struct {
			ID    string `json:"id"`
			Token string `json:"token"`
		} `json:"result"`
		Errors []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := doJSON(c.HTTP, http.MethodPost, url, headers, body, &resp); err != nil {
		return nil, fmt.Errorf("could not create the protected connection: %w", err)
	}
	if !resp.Success {
		if len(resp.Errors) > 0 {
			return nil, fmt.Errorf("could not create the protected connection: %s", resp.Errors[0].Message)
		}
		return nil, fmt.Errorf("could not create the protected connection")
	}
	return &TunnelCredentials{TunnelID: resp.Result.ID, Token: resp.Result.Token}, nil
}

func (c *TunnelClient) ConfigureIngress(accountID, apiToken, tunnelID, hostname, serviceURL string) error {
	if c.MockMode {
		return nil
	}
	url := fmt.Sprintf("%s/accounts/%s/cfd_tunnel/%s/configurations", c.api(), accountID, tunnelID)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}
	body := map[string]any{
		"config": map[string]any{
			"ingress": []map[string]string{
				{"hostname": hostname, "service": serviceURL},
				{"service": "http_status:404"},
			},
		},
	}
	return doJSON(c.HTTP, http.MethodPut, url, headers, body, nil)
}

func (c *TunnelClient) DeleteTunnel(accountID, apiToken, tunnelID string) error {
	if c.MockMode || tunnelID == "" {
		return nil
	}
	url := fmt.Sprintf("%s/accounts/%s/cfd_tunnel/%s", c.api(), accountID, tunnelID)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}
	return doJSON(c.HTTP, http.MethodDelete, url, headers, nil, nil)
}
