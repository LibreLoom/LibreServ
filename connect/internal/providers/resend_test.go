package providers

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestResendCreateAPIKey(t *testing.T) {
	var requestBody map[string]string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api-keys" {
			http.NotFound(w, r)
			return
		}
		if auth := r.Header.Get("Authorization"); auth != "Bearer re_123" {
			t.Fatalf("authorization=%s", auth)
		}
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &requestBody); err != nil {
			t.Fatalf("decode body: %v", err)
		}
		if requestBody["name"] != "libreserv-test" {
			t.Fatalf("name=%s", requestBody["name"])
		}
		if requestBody["permission"] != "sending_access" {
			t.Fatalf("permission=%s", requestBody["permission"])
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]string{
			"id":    "key-id-1",
			"token": "re_generated",
			"name":  "libreserv-test",
		})
	}))
	defer ts.Close()

	client := NewResendClient(ts.Client())
	client.baseURL = ts.URL + "/api-keys"

	smtp, err := client.CreateAPIKey("re_123", "libreserv-test")
	if err != nil {
		t.Fatalf("create api key: %v", err)
	}
	if smtp.Host != "smtp.resend.com" {
		t.Fatalf("host=%s", smtp.Host)
	}
	if smtp.Port != 587 {
		t.Fatalf("port=%d", smtp.Port)
	}
	if smtp.Username != "resend" {
		t.Fatalf("username=%s", smtp.Username)
	}
	if smtp.Password != "re_generated" {
		t.Fatalf("password=%s", smtp.Password)
	}
}
