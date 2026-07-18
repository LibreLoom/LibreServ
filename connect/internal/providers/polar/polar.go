package polar

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Client calls the Polar API using stdlib net/http only.
type Client struct {
	accessToken string
	baseURL     string
	http        *http.Client
}

// NewClient creates a Polar API client. If sandbox is true, uses the sandbox API.
func NewClient(accessToken string, sandbox bool) *Client {
	baseURL := "https://api.polar.sh"
	if sandbox {
		baseURL = "https://sandbox-api.polar.sh"
	}
	return &Client{
		accessToken: accessToken,
		baseURL:     baseURL,
		http: &http.Client{
			Timeout: 30 * time.Second,
		},
	}
}

// CheckoutSession represents a Polar checkout session.
type CheckoutSession struct {
	ID  string `json:"id"`
	URL string `json:"url"`
}

// CreateCheckout creates a checkout session for a product.
// externalCustomerID links the checkout to our internal device/account ID.
// successURL is where Polar redirects after payment.
func (c *Client) CreateCheckout(ctx context.Context, productID, externalCustomerID, successURL, customerIP string) (*CheckoutSession, error) {
	body := map[string]any{
		"products": []string{productID},
	}
	if externalCustomerID != "" {
		body["external_customer_id"] = externalCustomerID
	}
	if successURL != "" {
		body["success_url"] = successURL
	}
	if customerIP != "" {
		body["customer_ip_address"] = customerIP
	}

	var resp CheckoutSession
	if err := c.do(ctx, http.MethodPost, "/v1/checkouts/", body, &resp); err != nil {
		return nil, fmt.Errorf("create checkout: %w", err)
	}
	return &resp, nil
}

// RevokeSubscription cancels a subscription immediately.
func (c *Client) RevokeSubscription(ctx context.Context, subscriptionID string) error {
	path := fmt.Sprintf("/v1/subscriptions/%s", subscriptionID)
	return c.do(ctx, http.MethodDelete, path, nil, nil)
}

// UpdateSubscriptionProduct changes the product on an active subscription.
func (c *Client) UpdateSubscriptionProduct(ctx context.Context, subscriptionID, productID string) error {
	path := fmt.Sprintf("/v1/subscriptions/%s", subscriptionID)
	body := map[string]any{
		"product_id": productID,
	}
	return c.do(ctx, http.MethodPatch, path, body, nil)
}

// do executes an API request. out is optional; if nil, response body is discarded.
func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var bodyReader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return fmt.Errorf("marshal body: %w", err)
		}
		bodyReader = bytes.NewReader(data)
	}

	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return fmt.Errorf("create request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+c.accessToken)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("http request: %w", err)
	}
	defer resp.Body.Close()

	respBody, _ := io.ReadAll(resp.Body)

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return fmt.Errorf("polar API %s %s: status %d: %s", method, path, resp.StatusCode, string(respBody))
	}

	if out != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, out); err != nil {
			return fmt.Errorf("unmarshal response: %w", err)
		}
	}
	return nil
}

// ExtractBearerToken strips the "Bearer " prefix from an Authorization header.
func ExtractBearerToken(header string) string {
	return strings.TrimPrefix(header, "Bearer ")
}
