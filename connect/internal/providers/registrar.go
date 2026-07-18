package providers

import (
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// RegistrarClient talks to the Cloudflare Registrar API.
// It searches, checks availability, and registers domains at cost.
// Domains are registered to the Cloudflare account that owns the API token.
type RegistrarClient struct {
	httpClient *http.Client
	baseURL    string
}

// NewRegistrarClient creates a registrar client with the given HTTP client or a default 15s timeout.
func NewRegistrarClient(httpClient *http.Client) *RegistrarClient {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
	}
	return &RegistrarClient{httpClient: httpClient}
}

// DomainResult holds availability and pricing for a domain.
type DomainResult struct {
	Name             string `json:"name"`
	Registrable      bool   `json:"registrable"`
	Tier             string `json:"tier,omitempty"`
	Reason           string `json:"reason,omitempty"`
	RegistrationCost string `json:"registration_cost,omitempty"`
	RenewalCost      string `json:"renewal_cost,omitempty"`
	Currency         string `json:"currency,omitempty"`
}

// registrarSearchResponse is the response from GET /accounts/{id}/registrar/domain-search.
type registrarSearchResponse struct {
	Result struct {
		Domains []struct {
			Name        string `json:"name"`
			Registrable bool   `json:"registrable"`
			Tier        string `json:"tier"`
			Pricing     struct {
				Currency         string `json:"currency"`
				RegistrationCost string `json:"registration_cost"`
				RenewalCost      string `json:"renewal_cost"`
			} `json:"pricing"`
		} `json:"domains"`
	} `json:"result"`
	Success bool `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
}

// SearchDomains searches for available domains matching a query.
func (c *RegistrarClient) SearchDomains(accountID, apiToken, query string, limit int) ([]DomainResult, error) {
	if accountID == "" || apiToken == "" {
		return nil, fmt.Errorf("Cloudflare account ID and API token are required")
	}
	if query == "" {
		return nil, fmt.Errorf("search query is required")
	}

	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.cloudflare.com/client/v4"
	}

	if limit <= 0 {
		limit = 5
	}

	searchURL := fmt.Sprintf("%s/accounts/%s/registrar/domain-search?q=%s&limit=%d",
		baseURL, accountID, url.QueryEscape(query), limit)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}

	var resp registrarSearchResponse
	if _, err := doJSON(c.httpClient, http.MethodGet, searchURL, headers, nil, &resp); err != nil {
		return nil, fmt.Errorf("could not search domains: %w", err)
	}
	if !resp.Success && len(resp.Errors) > 0 {
		return nil, fmt.Errorf("Cloudflare API error: %s", resp.Errors[0].Message)
	}

	results := make([]DomainResult, 0, len(resp.Result.Domains))
	for _, d := range resp.Result.Domains {
		results = append(results, DomainResult{
			Name:             d.Name,
			Registrable:      d.Registrable,
			Tier:             d.Tier,
			RegistrationCost: d.Pricing.RegistrationCost,
			RenewalCost:      d.Pricing.RenewalCost,
			Currency:         d.Pricing.Currency,
		})
	}
	return results, nil
}

// registrarCheckResponse is the response from POST /accounts/{id}/registrar/domain-check.
type registrarCheckResponse struct {
	Result struct {
		Domains []struct {
			Name        string `json:"name"`
			Registrable bool   `json:"registrable"`
			Tier        string `json:"tier"`
			Reason      string `json:"reason,omitempty"`
			Pricing     struct {
				Currency         string `json:"currency"`
				RegistrationCost string `json:"registration_cost"`
				RenewalCost      string `json:"renewal_cost"`
			} `json:"pricing"`
		} `json:"domains"`
	} `json:"result"`
	Success bool `json:"success"`
}

// CheckDomain checks real-time availability and pricing for a specific domain.
// Always call this before RegisterDomain.
func (c *RegistrarClient) CheckDomain(accountID, apiToken, domain string) (*DomainResult, error) {
	if accountID == "" || apiToken == "" {
		return nil, fmt.Errorf("Cloudflare account ID and API token are required")
	}
	if domain == "" {
		return nil, fmt.Errorf("domain name is required")
	}

	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.cloudflare.com/client/v4"
	}

	checkURL := fmt.Sprintf("%s/accounts/%s/registrar/domain-check", baseURL, accountID)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}
	body := map[string][]string{"domains": {domain}}

	var resp registrarCheckResponse
	if _, err := doJSON(c.httpClient, http.MethodPost, checkURL, headers, body, &resp); err != nil {
		return nil, fmt.Errorf("could not check domain: %w", err)
	}
	if !resp.Success {
		return nil, fmt.Errorf("Cloudflare API returned no results")
	}
	if len(resp.Result.Domains) == 0 {
		return nil, fmt.Errorf("no results for domain %s", domain)
	}

	d := resp.Result.Domains[0]
	return &DomainResult{
		Name:             d.Name,
		Registrable:      d.Registrable,
		Tier:             d.Tier,
		Reason:           d.Reason,
		RegistrationCost: d.Pricing.RegistrationCost,
		RenewalCost:      d.Pricing.RenewalCost,
		Currency:         d.Pricing.Currency,
	}, nil
}

// registrarRegisterResponse is the response from POST /accounts/{id}/registrar/registrations.
type registrarRegisterResponse struct {
	Result struct {
		DomainName string `json:"domain_name"`
		State      string `json:"state"`
	} `json:"result"`
	Success bool `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
}

// RegisterDomain registers a domain via Cloudflare Registrar.
// The domain is registered to the Cloudflare account that owns the API token.
// The account must have a default registrant contact and payment method configured.
func (c *RegistrarClient) RegisterDomain(accountID, apiToken, domain string) error {
	if accountID == "" || apiToken == "" {
		return fmt.Errorf("Cloudflare account ID and API token are required")
	}
	if domain == "" {
		return fmt.Errorf("domain name is required")
	}

	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.cloudflare.com/client/v4"
	}

	registerURL := fmt.Sprintf("%s/accounts/%s/registrar/registrations", baseURL, accountID)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}
	body := map[string]string{"domain_name": domain}

	var resp registrarRegisterResponse
	if _, err := doJSON(c.httpClient, http.MethodPost, registerURL, headers, body, &resp); err != nil {
		return fmt.Errorf("could not register domain: %w", err)
	}
	if !resp.Success && len(resp.Errors) > 0 {
		return fmt.Errorf("Cloudflare API error: %s", resp.Errors[0].Message)
	}
	if resp.Result.State != "succeeded" && resp.Result.State != "pending" {
		return fmt.Errorf("domain registration state: %s", resp.Result.State)
	}
	return nil
}
