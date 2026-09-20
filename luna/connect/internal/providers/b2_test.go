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
			body, _ := io.ReadAll(r.Body)
			var req map[string]string
			if err := json.Unmarshal(body, &req); err != nil {
				t.Fatalf("decode bucket body: %v", err)
			}
			if req["bucketName"] != "luna-backup-dev-abc" {
				t.Fatalf("bucketName=%s", req["bucketName"])
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
	creds, err := client.ProvisionBucket("acc123", "key456", "luna-backup-dev-abc")
	if err != nil {
		t.Fatalf("provision bucket: %v", err)
	}
	if !authorizeCalled || !createBucketCalled || !createKeyCalled {
		t.Fatal("expected authorize, create bucket, and create key")
	}
	if creds.Endpoint != "https://s3.us-west-001.backblazeb2.com" {
		t.Fatalf("endpoint=%s", creds.Endpoint)
	}
	if creds.KeyID != "keyid123" || creds.Key != "appkey456" || creds.BucketName != "luna-backup-dev-abc" {
		t.Fatalf("creds=%+v", creds)
	}
	if creds.BucketID != "buc123" {
		t.Fatalf("bucketId=%s", creds.BucketID)
	}
}

func TestB2ProvisionBucketIdempotentWhenExists(t *testing.T) {
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/b2api/v2/b2_authorize_account" {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accountId":          "acc123",
				"authorizationToken": "tok123",
				"apiUrl":             "http://" + r.Host,
				"s3ApiUrl":           "https://s3.us-west-001.backblazeb2.com",
			})
			return
		}
		if strings.Contains(r.URL.Path, "b2_create_bucket") {
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"duplicate_bucket_name","message":"Bucket name is already in use"}`))
			return
		}
		if strings.Contains(r.URL.Path, "b2_list_buckets") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"buckets": []map[string]string{
					{"bucketId": "buc-existing", "bucketName": "luna-backup-dev-abc"},
				},
			})
			return
		}
		if strings.Contains(r.URL.Path, "b2_create_key") {
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]string{
				"applicationKeyId": "keyid-new",
				"applicationKey":   "appkey-new",
			})
			return
		}
		http.NotFound(w, r)
	}))
	defer ts.Close()

	client := NewB2Client(ts.Client())
	client.authorizeURL = ts.URL + "/b2api/v2/b2_authorize_account"
	creds, err := client.ProvisionBucket("acc123", "key456", "luna-backup-dev-abc")
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	if creds.BucketID != "buc-existing" {
		t.Fatalf("bucketId=%s", creds.BucketID)
	}
	if creds.KeyID != "keyid-new" {
		t.Fatalf("keyId=%s", creds.KeyID)
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

func TestAuthorizeV4NestedShape(t *testing.T) {
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
	if auth.APIURL != "https://api004.backblazeb2.com" {
		t.Fatalf("apiUrl=%s", auth.APIURL)
	}
	if auth.S3APIURL != "https://s3.us-west-004.backblazeb2.com" {
		t.Fatalf("s3ApiUrl=%s", auth.S3APIURL)
	}
}

func TestSanitizeBucketPart(t *testing.T) {
	if got := sanitizeBucketPart("dev_AbC-12"); got != "dev-abc-12" {
		t.Fatalf("got %q", got)
	}
	if got := sanitizeBucketPart("luna backup!!"); got != "lunabackup" {
		t.Fatalf("got %q", got)
	}
}
