package providers

import (
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Tunnel is the Cloudflare tunnel surface Name/Unregister use.
type Tunnel interface {
	CreateTunnel(accountID, apiToken, name string) (*TunnelCredentials, error)
	ConfigureIngress(accountID, apiToken, tunnelID, hostname, serviceURL string) error
	DeleteTunnel(accountID, apiToken, tunnelID string) error
	ListTunnels(accountID, apiToken string) ([]TunnelInfo, error)
}

// TunnelInfo is one tunnel as Cloudflare lists it.
type TunnelInfo struct {
	ID        string
	Name      string
	CreatedAt time.Time
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
	return &TunnelClient{HTTP: defaultHTTPClient()}
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
	token := resp.Result.Token
	if token == "" && resp.Result.ID != "" {
		fetched, err := c.fetchTunnelToken(accountID, apiToken, resp.Result.ID)
		if err != nil {
			return nil, err
		}
		token = fetched
	}
	if token == "" {
		return nil, fmt.Errorf("could not create the protected connection: tunnel secret was empty")
	}
	return &TunnelCredentials{TunnelID: resp.Result.ID, Token: token}, nil
}

func (c *TunnelClient) fetchTunnelToken(accountID, apiToken, tunnelID string) (string, error) {
	url := fmt.Sprintf("%s/accounts/%s/cfd_tunnel/%s/token", c.api(), accountID, tunnelID)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}
	var resp struct {
		Success bool   `json:"success"`
		Result  string `json:"result"`
		Errors  []struct {
			Message string `json:"message"`
		} `json:"errors"`
	}
	if err := doJSON(c.HTTP, http.MethodGet, url, headers, nil, &resp); err != nil {
		return "", fmt.Errorf("could not fetch the tunnel secret: %w", err)
	}
	if !resp.Success {
		if len(resp.Errors) > 0 {
			return "", fmt.Errorf("could not fetch the tunnel secret: %s", resp.Errors[0].Message)
		}
		return "", fmt.Errorf("could not fetch the tunnel secret")
	}
	return resp.Result, nil
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

// DeleteTunnel removes a tunnel. Cloudflare refuses to delete one that still has connected
// connectors, so those are cleared first. A tunnel that is already gone counts as deleted.
func (c *TunnelClient) DeleteTunnel(accountID, apiToken, tunnelID string) error {
	if c.MockMode || tunnelID == "" {
		return nil
	}
	base := fmt.Sprintf("%s/accounts/%s/cfd_tunnel/%s", c.api(), accountID, tunnelID)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}
	_ = doJSON(c.HTTP, http.MethodDelete, base+"/connections", headers, nil, nil)
	if err := doJSON(c.HTTP, http.MethodDelete, base, headers, nil, nil); err != nil {
		if strings.Contains(err.Error(), "status 404") {
			return nil
		}
		return err
	}
	return nil
}

// ListTunnels returns every tunnel in the account that is not deleted.
func (c *TunnelClient) ListTunnels(accountID, apiToken string) ([]TunnelInfo, error) {
	if c.MockMode {
		return nil, nil
	}
	headers := map[string]string{"Authorization": "Bearer " + apiToken}
	var out []TunnelInfo
	for page := 1; page <= 20; page++ {
		url := fmt.Sprintf("%s/accounts/%s/cfd_tunnel?is_deleted=false&per_page=100&page=%d", c.api(), accountID, page)
		var resp struct {
			Result []struct {
				ID        string `json:"id"`
				Name      string `json:"name"`
				CreatedAt string `json:"created_at"`
			} `json:"result"`
			ResultInfo struct {
				TotalPages int `json:"total_pages"`
			} `json:"result_info"`
		}
		if err := doJSON(c.HTTP, http.MethodGet, url, headers, nil, &resp); err != nil {
			return nil, err
		}
		for _, t := range resp.Result {
			created, _ := time.Parse(time.RFC3339Nano, t.CreatedAt)
			out = append(out, TunnelInfo{ID: t.ID, Name: t.Name, CreatedAt: created})
		}
		if page >= resp.ResultInfo.TotalPages {
			break
		}
	}
	return out, nil
}
