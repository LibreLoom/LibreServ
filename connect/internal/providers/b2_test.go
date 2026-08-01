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
			body, _ := io.ReadAll(r.Body)
			if string(body) != "{}" {
				t.Fatalf("authorize body=%q, want {}", body)
			}
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accountId":          "acc123",
				"authorizationToken": "tok123",
				"apiUrl":             "http://" + r.Host,
				"downloadUrl":        "http://" + r.Host,
				"s3ApiUrl":           "https://s3.us-west-001.backblazeb2.com",
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
			if req["accountId"] != "acc123" {
				t.Fatalf("accountId=%s", req["accountId"])
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
			if req["accountId"] != "acc123" {
				t.Fatalf("key accountId=%v", req["accountId"])
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
	// The mock authorize response provides an explicit s3ApiUrl, which is used verbatim.
	if creds.Endpoint != "https://s3.us-west-001.backblazeb2.com" {
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
		wantErr  bool
	}{
		{"https://api001.backblazeb2.com", "s3.us-west-001.backblazeb2.com", false},
		{"https://api004.backblazeb2.com/", "s3.us-west-004.backblazeb2.com", false},
		{"http://api.example.com", "", true},
		{"", "", true},
	}
	for _, c := range cases {
		got, err := b2S3Endpoint(c.input)
		if c.wantErr {
			if err == nil {
				t.Errorf("b2S3Endpoint(%q) expected error, got %q", c.input, got)
			}
			continue
		}
		if err != nil {
			t.Errorf("b2S3Endpoint(%q) unexpected error: %v", c.input, err)
			continue
		}
		if got != c.expected {
			t.Errorf("b2S3Endpoint(%q)=%q, want %q", c.input, got, c.expected)
		}
	}
}

func TestS3EndpointFor(t *testing.T) {
	// The authoritative s3ApiUrl wins over the apiUrl derivation (trailing slash trimmed).
	auth := &b2AuthResponse{
		APIURL:   "https://api004.backblazeb2.com",
		S3APIURL: "https://s3.us-west-004.backblazeb2.com/",
	}
	got, err := s3EndpointFor(auth)
	if err != nil {
		t.Fatalf("s3EndpointFor: %v", err)
	}
	if got != "https://s3.us-west-004.backblazeb2.com" {
		t.Fatalf("endpoint=%q, want s3ApiUrl verbatim", got)
	}

	// Without s3ApiUrl, the legacy apiNNN derivation is used.
	auth = &b2AuthResponse{APIURL: "https://api001.backblazeb2.com"}
	got, err = s3EndpointFor(auth)
	if err != nil {
		t.Fatalf("s3EndpointFor: %v", err)
	}
	if got != "s3.us-west-001.backblazeb2.com" {
		t.Fatalf("endpoint=%q, want legacy derivation", got)
	}

	// Neither present: error, never a fabricated hostname.
	auth = &b2AuthResponse{APIURL: "https://api.example.com"}
	if _, err := s3EndpointFor(auth); err == nil {
		t.Fatal("s3EndpointFor expected error for non-B2 apiUrl without s3ApiUrl")
	}
}

func TestAuthorizeV4NestedShape(t *testing.T) {
	// v4 authorize responses nest the storage API fields under apiInfo.storageApi.
	body := `{"accountId":"acc123","authorizationToken":"tok123","apiInfo":{"storageApi":{"apiUrl":"https://api004.backblazeb2.com","downloadUrl":"https://f004.backblazeb2.com","s3ApiUrl":"https://s3.us-west-004.backblazeb2.com"}}}`
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	defer ts.Close()

	client := NewB2Client(ts.Client())
	client.authorizeURL = ts.URL + "/b2api/v2/b2_authorize_account"
	auth, err := client.Authorize("acc123", "key456")
	if err != nil {
		t.Fatalf("authorize: %v", err)
	}
	if auth.AccountID != "acc123" {
		t.Fatalf("accountId=%s", auth.AccountID)
	}
	if auth.APIURL != "https://api004.backblazeb2.com" {
		t.Fatalf("apiUrl=%s", auth.APIURL)
	}
	if auth.S3APIURL != "https://s3.us-west-004.backblazeb2.com" {
		t.Fatalf("s3ApiUrl=%s", auth.S3APIURL)
	}
}
