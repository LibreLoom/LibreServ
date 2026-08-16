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

// SetBaseURL overrides the API base URL (for testing).
func (c *RegistrarClient) SetBaseURL(url string) { c.baseURL = url }

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
		return nil, fmt.Errorf("cloudflare account ID and API token are required")
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
		return nil, fmt.Errorf("cloudflare API error: %s", resp.Errors[0].Message)
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
		return nil, fmt.Errorf("cloudflare account ID and API token are required")
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
		return nil, fmt.Errorf("cloudflare API returned no results")
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
// The context.registration.expires_at is present when the registration succeeds synchronously.
type registrarRegisterResponse struct {
	Result struct {
		DomainName string `json:"domain_name"`
		State      string `json:"state"`
		Context    struct {
			Registration struct {
				ExpiresAt string `json:"expires_at"`
			} `json:"registration"`
		} `json:"context"`
	} `json:"result"`
	Success bool `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
}

// RegisterDomain registers a domain via Cloudflare Registrar with auto-renew enabled.
// The domain is registered to the Cloudflare account that owns the API token.
// The account must have a default registrant contact and payment method configured.
// Returns the expiry time if available synchronously (zero value if pending).
func (c *RegistrarClient) RegisterDomain(accountID, apiToken, domain string) (time.Time, error) {
	if accountID == "" || apiToken == "" {
		return time.Time{}, fmt.Errorf("cloudflare account ID and API token are required")
	}
	if domain == "" {
		return time.Time{}, fmt.Errorf("domain name is required")
	}

	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.cloudflare.com/client/v4"
	}

	registerURL := fmt.Sprintf("%s/accounts/%s/registrar/registrations", baseURL, accountID)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}
	body := map[string]any{"domain_name": domain, "auto_renew": true}

	var resp registrarRegisterResponse
	if _, err := doJSON(c.httpClient, http.MethodPost, registerURL, headers, body, &resp); err != nil {
		return time.Time{}, fmt.Errorf("could not register domain: %w", err)
	}
	if !resp.Success && len(resp.Errors) > 0 {
		return time.Time{}, fmt.Errorf("cloudflare API error: %s", resp.Errors[0].Message)
	}
	if resp.Result.State != "succeeded" && resp.Result.State != "pending" {
		return time.Time{}, fmt.Errorf("domain registration state: %s", resp.Result.State)
	}

	// Parse expiry if synchronously available.
	if exp := resp.Result.Context.Registration.ExpiresAt; exp != "" {
		if t, err := time.Parse(time.RFC3339, exp); err == nil {
			return t, nil
		}
	}
	return time.Time{}, nil
}

// DomainInfo holds details for a registered domain from the Cloudflare Registrar API.
type DomainInfo struct {
	Name      string    `json:"name"`
	ExpiresAt time.Time `json:"expires_at"`
	AutoRenew bool      `json:"auto_renew"`
	Locked    bool      `json:"locked"`
	Status    string    `json:"status"`
}

// registrarDomainResponse is the response from GET /accounts/{id}/registrar/domains/{name}.
type registrarDomainResponse struct {
	Result struct {
		Name      string `json:"name"`
		ExpiresAt string `json:"expires_at"`
		AutoRenew bool   `json:"auto_renew"`
		Locked    bool   `json:"locked"`
		Status    string `json:"status"`
	} `json:"result"`
	Success bool `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
}

// GetDomain fetches live details for a registered domain from Cloudflare Registrar.
func (c *RegistrarClient) GetDomain(accountID, apiToken, domain string) (*DomainInfo, error) {
	if accountID == "" || apiToken == "" {
		return nil, fmt.Errorf("cloudflare account ID and API token are required")
	}
	if domain == "" {
		return nil, fmt.Errorf("domain name is required")
	}

	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.cloudflare.com/client/v4"
	}

	domainURL := fmt.Sprintf("%s/accounts/%s/registrar/domains/%s", baseURL, accountID, domain)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}

	var resp registrarDomainResponse
	if _, err := doJSON(c.httpClient, http.MethodGet, domainURL, headers, nil, &resp); err != nil {
		return nil, fmt.Errorf("could not get domain: %w", err)
	}
	if !resp.Success && len(resp.Errors) > 0 {
		return nil, fmt.Errorf("cloudflare API error: %s", resp.Errors[0].Message)
	}

	info := &DomainInfo{
		Name:      resp.Result.Name,
		AutoRenew: resp.Result.AutoRenew,
		Locked:    resp.Result.Locked,
		Status:    resp.Result.Status,
	}
	if exp := resp.Result.ExpiresAt; exp != "" {
		if t, err := time.Parse(time.RFC3339, exp); err == nil {
			info.ExpiresAt = t
		}
	}
	return info, nil
}

// registrarDomainListResponse is the response from GET /accounts/{id}/registrar/domains.
type registrarDomainListResponse struct {
	Result []struct {
		Name      string `json:"name"`
		ExpiresAt string `json:"expires_at"`
		AutoRenew bool   `json:"auto_renew"`
		Locked    bool   `json:"locked"`
		Status    string `json:"status"`
	} `json:"result"`
	Success bool `json:"success"`
	Errors  []struct {
		Code    int    `json:"code"`
		Message string `json:"message"`
	} `json:"errors"`
}

// ListDomains lists all registered domains in the Cloudflare account.
func (c *RegistrarClient) ListDomains(accountID, apiToken string) ([]DomainInfo, error) {
	if accountID == "" || apiToken == "" {
		return nil, fmt.Errorf("cloudflare account ID and API token are required")
	}

	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.cloudflare.com/client/v4"
	}

	listURL := fmt.Sprintf("%s/accounts/%s/registrar/domains", baseURL, accountID)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}

	var resp registrarDomainListResponse
	if _, err := doJSON(c.httpClient, http.MethodGet, listURL, headers, nil, &resp); err != nil {
		return nil, fmt.Errorf("could not list domains: %w", err)
	}
	if !resp.Success && len(resp.Errors) > 0 {
		return nil, fmt.Errorf("cloudflare API error: %s", resp.Errors[0].Message)
	}

	domains := make([]DomainInfo, 0, len(resp.Result))
	for _, d := range resp.Result {
		info := DomainInfo{
			Name:      d.Name,
			AutoRenew: d.AutoRenew,
			Locked:    d.Locked,
			Status:    d.Status,
		}
		if exp := d.ExpiresAt; exp != "" {
			if t, err := time.Parse(time.RFC3339, exp); err == nil {
				info.ExpiresAt = t
			}
		}
		domains = append(domains, info)
	}
	return domains, nil
}

// UpdateDomainAutoRenew enables or disables auto-renew on a registered domain.
func (c *RegistrarClient) UpdateDomainAutoRenew(accountID, apiToken, domain string, autoRenew bool) error {
	if accountID == "" || apiToken == "" {
		return fmt.Errorf("cloudflare account ID and API token are required")
	}
	if domain == "" {
		return fmt.Errorf("domain name is required")
	}

	baseURL := c.baseURL
	if baseURL == "" {
		baseURL = "https://api.cloudflare.com/client/v4"
	}

	updateURL := fmt.Sprintf("%s/accounts/%s/registrar/domains/%s", baseURL, accountID, domain)
	headers := map[string]string{"Authorization": "Bearer " + apiToken}
	body := map[string]bool{"auto_renew": autoRenew}

	var resp struct {
		Success bool `json:"success"`
		Errors  []struct {
			Code    int    `json:"code"`
			Message string `json:"message"`
		} `json:"errors"`
	}
	if _, err := doJSON(c.httpClient, http.MethodPut, updateURL, headers, body, &resp); err != nil {
		return fmt.Errorf("could not update domain auto-renew: %w", err)
	}
	if !resp.Success && len(resp.Errors) > 0 {
		return fmt.Errorf("cloudflare API error: %s", resp.Errors[0].Message)
	}
	return nil
}
