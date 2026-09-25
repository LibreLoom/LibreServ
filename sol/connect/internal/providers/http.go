package providers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// errProviderHTTPRedirect refuses HTTP redirects. Provider clients carry API
// tokens; following a 302 can send credentials or land on an unexpected host.
var errProviderHTTPRedirect = fmt.Errorf("provider HTTP client does not follow redirects")

// defaultHTTPClient is the nil-fallback client for provider constructors.
// Timeout matches the previous 15s default; CheckRedirect refuses all redirects.
func defaultHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 15 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errProviderHTTPRedirect
		},
	}
}

// doJSON performs an HTTP request with an optional JSON body and decodes the JSON response into v.
// If v is nil, the response body is discarded.
func doJSON(client *http.Client, method, url string, headers map[string]string, body, v any) (int, error) {
	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return 0, fmt.Errorf("encode request body: %w", err)
		}
		bodyReader = bytes.NewReader(b)
	}

	req, err := http.NewRequest(method, url, bodyReader)
	if err != nil {
		return 0, fmt.Errorf("create request: %w", err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", "application/json")
	for k, v := range headers {
		req.Header.Set(k, v)
	}

	resp, err := client.Do(req)
	if err != nil {
		return 0, fmt.Errorf("request failed: %w", err)
	}
	defer resp.Body.Close()

	respBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, fmt.Errorf("read response body: %w", err)
	}

	if resp.StatusCode >= 400 {
		return resp.StatusCode, fmt.Errorf("provider returned status %d: %s", resp.StatusCode, string(respBody))
	}

	if v != nil && len(respBody) > 0 {
		if err := json.Unmarshal(respBody, v); err != nil {
			return resp.StatusCode, fmt.Errorf("decode response: %w", err)
		}
	}

	return resp.StatusCode, nil
}
