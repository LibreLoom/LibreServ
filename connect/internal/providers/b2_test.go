package providers

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestB2ProvisionBucket(t *testing.T) {
	var authorizeCalled, createBucketCalled, createKeyCalled bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/b2api/v2/b2_authorize_account" {
			authorizeCalled = true
			if auth := r.Header.Get("Authorization"); auth != "Basic YWNjMTIzOmtleTQ1Ng==" {
				t.Fatalf("auth header=%s", auth)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{
				"authorizationToken": "tok123",
				"apiUrl":             "http://" + r.Host,
				"downloadUrl":        "http://" + r.Host,
			})
			return
		}
		if strings.Contains(r.URL.Path, "b2_create_bucket") {
			createBucketCalled = true
			if auth := r.Header.Get("Authorization"); auth != "tok123" {
				t.Fatalf("bucket auth=%s", auth)
			}
			body, _ := io.ReadAll(r.Body)
			var req map[string]string
			if err := json.Unmarshal(body, &req); err != nil {
				t.Fatalf("decode bucket body: %v", err)
			}
			if req["bucketName"] != "libreserv-backup-abc123" {
				t.Fatalf("bucketName=%s", req["bucketName"])
			}
			if req["bucketType"] != "allPrivate" {
				t.Fatalf("bucketType=%s", req["bucketType"])
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{
				"bucketId":   "buc123",
				"bucketName": req["bucketName"],
			})
			return
		}
		if strings.Contains(r.URL.Path, "b2_create_key") {
			createKeyCalled = true
			if auth := r.Header.Get("Authorization"); auth != "tok123" {
				t.Fatalf("key auth=%s", auth)
			}
			body, _ := io.ReadAll(r.Body)
			var req map[string]any
			if err := json.Unmarshal(body, &req); err != nil {
				t.Fatalf("decode key body: %v", err)
			}
			if req["keyName"] != "libreserv-backup-abc123-key" {
				t.Fatalf("keyName=%v", req["keyName"])
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{
				"applicationKeyId": "keyid123",
				"applicationKey":   "appkey456",
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	client := NewB2Client(ts.Client())
	client.authorizeURL = ts.URL + "/b2api/v2/b2_authorize_account"
	creds, err := client.ProvisionBucket("acc123", "key456", "libreserv-backup-abc123")
	if err != nil {
		t.Fatalf("provision bucket: %v", err)
	}

	if !authorizeCalled {
		t.Fatal("authorize not called")
	}
	if !createBucketCalled {
		t.Fatal("create bucket not called")
	}
	if !createKeyCalled {
		t.Fatal("create key not called")
	}
	// The test server returns a non-B2 URL, so derivation falls back to the default B2 S3 endpoint.
	if creds.Endpoint != "s3.backblazeb2.com" {
		t.Fatalf("endpoint=%s", creds.Endpoint)
	}
	if creds.KeyID != "keyid123" {
		t.Fatalf("keyID=%s", creds.KeyID)
	}
	if creds.Key != "appkey456" {
		t.Fatalf("key=%s", creds.Key)
	}
	if creds.BucketName != "libreserv-backup-abc123" {
		t.Fatalf("bucketName=%s", creds.BucketName)
	}
}

func TestB2S3Endpoint(t *testing.T) {
	cases := []struct {
		input    string
		expected string
	}{
		{"https://api001.backblazeb2.com", "s3.001.backblazeb2.com"},
		{"https://api999.backblazeb2.com/", "s3.999.backblazeb2.com"},
		{"http://api.example.com", "s3.backblazeb2.com"},
		{"", "s3.backblazeb2.com"},
	}
	for _, c := range cases {
		got := b2S3Endpoint(c.input)
		if got != c.expected {
			t.Errorf("b2S3Endpoint(%q)=%q, want %q", c.input, got, c.expected)
		}
	}
}
