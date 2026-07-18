package providers

import (
	"fmt"
	"net/http"
	"time"
)

// TunnelClient talks to the Cloudflare Tunnel API.
// It creates, configures, and deletes named tunnels that route traffic
// from a Cloudflare edge hostname to a local service on the device.
type TunnelClient struct {
	httpClient *http.Client
	baseURL    string
}

// NewTunnelClient creates a tunnel client with the given HTTP client or a default 15s timeout.
func NewTunnelClient(httpClient *http.Client) *TunnelClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	return &TunnelClient{httpClient: httpClient}
}

// TunnelCredentials holds the result of creating a tunnel.
// The Token is what the device passes to `cloudflared tunnel run --token <token>`.
type TunnelCredentials struct {
	TunnelID string `json:"tunnel_id"`
	Token    string `json:"tunnel_token"`
}

// tunnelCreateResponse is the response from POST /accounts/{id}/cfd_tunnel.
type tunnelCreateResponse struct {
	Result struct {
		ID       string            `json:"id"`
		Name     string            `json:"name"`
		Status   string            `json:"status"`
		Token    string            `json:"token"`
		CredFile map[string]string `json:"credentials_file"`
	} `json:"result"`
	Success bool `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
}

// CreateTunnel creates a named Cloudflare Tunnel. The tunnel starts inactive
// until cloudflared on the device connects with the returned token.
func (c *TunnelClient) CreateTunnel(accountID, apiToken, name string) (*TunnelCredentials, error) {
	if accountID == "" || apiToken == "" {
		return nil, fmt.Errorf("Cloudflare account ID and API token are required")
	}
	if name == "" {
		return nil, fmt.Errorf("tunnel name is required")
	}

	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.cloudflare.com/client/v4"
	}

	url := fmt.Sprintf("%s/accounts/%s/cfd_tunnel", baseURL, accountID)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}
	body := map[string]string{"name": name, "config_src": "cloudflare"}

	var resp tunnelCreateResponse
	if _, err := doJSON(c.httpClient, http.MethodPost, url, headers, body, &resp); err != nil {
		return nil, fmt.Errorf("could not create Cloudflare tunnel: %w", err)
	}
	if !resp.Success {
		if len(resp.Errors) > 0 {
			return nil, fmt.Errorf("Cloudflare API error: %s", resp.Errors[0].Message)
		}
		return nil, fmt.Errorf("Cloudflare API returned no tunnel")
	}

	return &TunnelCredentials{
		TunnelID: resp.Result.ID,
		Token:    resp.Result.Token,
	}, nil
}

// ingressConfig is the body for PUT /accounts/{id}/cfd_tunnel/{id}/configurations.
type ingressConfig struct {
	Config struct {
		Ingress []ingressRule `json:"ingress"`
	} `json:"config"`
}

type ingressRule struct {
	Hostname      string         `json:"hostname,omitempty"`
	Service       string         `json:"service"`
	OriginRequest map[string]any `json:"originRequest,omitempty"`
}

// ConfigureIngress sets the tunnel's routing rules. The hostname (e.g.
// "myserver.servers.libreloom.org") is mapped to a local service URL
// (e.g. "http://localhost:8080"). A catch-all 404 rule is appended.
func (c *TunnelClient) ConfigureIngress(accountID, apiToken, tunnelID, hostname, serviceURL string) error {
	if tunnelID == "" || hostname == "" || serviceURL == "" {
		return fmt.Errorf("tunnel ID, hostname, and service URL are required")
	}

	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.cloudflare.com/client/v4"
	}

	url := fmt.Sprintf("%s/accounts/%s/cfd_tunnel/%s/configurations", baseURL, accountID, tunnelID)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}

	cfg := ingressConfig{}
	cfg.Config.Ingress = []ingressRule{
		{Hostname: hostname, Service: serviceURL},
		{Service: "http_status:404"},
	}

	var resp tunnelCreateResponse
	if _, err := doJSON(c.httpClient, http.MethodPut, url, headers, cfg, &resp); err != nil {
		return fmt.Errorf("could not configure tunnel ingress: %w", err)
	}
	if !resp.Success && len(resp.Errors) > 0 {
		return fmt.Errorf("Cloudflare API error: %s", resp.Errors[0].Message)
	}
	return nil
}

// DeleteTunnel removes a Cloudflare Tunnel. The DNS CNAME must be cleaned up
// separately via the Cloudflare DNS API.
func (c *TunnelClient) DeleteTunnel(accountID, apiToken, tunnelID string) error {
	if tunnelID == "" {
		return fmt.Errorf("tunnel ID is required")
	}

	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.cloudflare.com/client/v4"
	}

	url := fmt.Sprintf("%s/accounts/%s/cfd_tunnel/%s", baseURL, accountID, tunnelID)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}

	if _, err := doJSON(c.httpClient, http.MethodDelete, url, headers, nil, nil); err != nil {
		return fmt.Errorf("could not delete Cloudflare tunnel: %w", err)
	}
	return nil
}

// TunnelStatus holds the health info for a tunnel.
type TunnelStatus struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Status string `json:"status"`
}

// tunnelStatusResponse is the response from GET /accounts/{id}/cfd_tunnel/{id}.
type tunnelStatusResponse struct {
	Result struct {
		ID     string `json:"id"`
		Name   string `json:"name"`
		Status string `json:"status"`
	} `json:"result"`
	Success bool `json:"success"`
}

// GetTunnelStatus returns the current health and connection status of a tunnel.
func (c *TunnelClient) GetTunnelStatus(accountID, apiToken, tunnelID string) (*TunnelStatus, error) {
	if tunnelID == "" {
		return nil, fmt.Errorf("tunnel ID is required")
	}

	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.cloudflare.com/client/v4"
	}

	url := fmt.Sprintf("%s/accounts/%s/cfd_tunnel/%s", baseURL, accountID, tunnelID)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}

	var resp tunnelStatusResponse
	if _, err := doJSON(c.httpClient, http.MethodGet, url, headers, nil, &resp); err != nil {
		return nil, fmt.Errorf("could not get tunnel status: %w", err)
	}
	if !resp.Success {
		return nil, fmt.Errorf("Cloudflare API returned no tunnel")
	}

	return &TunnelStatus{
		ID:     resp.Result.ID,
		Name:   resp.Result.Name,
		Status: resp.Result.Status,
	}, nil
}
