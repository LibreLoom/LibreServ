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

func doJSON(client *http.Client, method, url string, headers map[string]string, body, v any) error {
	var bodyReader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		bodyReader = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, url, bodyReader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, val := range headers {
		req.Header.Set(k, val)
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return err
	}
	if resp.StatusCode >= 400 {
		return fmt.Errorf("provider returned status %d: %s", resp.StatusCode, string(raw))
	}
	if v != nil && len(raw) > 0 {
		return json.Unmarshal(raw, v)
	}
	return nil
}
