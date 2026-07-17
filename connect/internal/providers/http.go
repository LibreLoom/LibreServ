package providers

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
)

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
