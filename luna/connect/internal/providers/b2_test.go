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
			var req map[string]any
			if err := json.Unmarshal(body, &req); err != nil {
				t.Fatalf("decode bucket body: %v", err)
			}
			if req["bucketName"] != "luna-backup-dev-abc" {
				t.Fatalf("bucketName=%v", req["bucketName"])
			}
			assertKeepLastVersionRules(t, req["lifecycleRules"])
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bucketId":       "buc123",
				"bucketName":     req["bucketName"],
				"lifecycleRules": keepLastVersionRules(),
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
				"buckets": []map[string]any{
					{"bucketId": "buc-existing", "bucketName": "luna-backup-dev-abc", "lifecycleRules": keepLastVersionRulesJSON()},
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

// assertKeepLastVersionRules checks the lifecycleRules sent to B2 are exactly one rule that
// hides and deletes a day later, with no daysFromUploadingToHiding key at all.
func assertKeepLastVersionRules(t *testing.T, got any) {
	t.Helper()
	rules, ok := got.([]any)
	if !ok || len(rules) != 1 {
		t.Fatalf("lifecycleRules=%#v, want one rule", got)
	}
	rule, ok := rules[0].(map[string]any)
	if !ok {
		t.Fatalf("rule=%#v", rules[0])
	}
	if rule["fileNamePrefix"] != "" {
		t.Fatalf("fileNamePrefix=%#v, want empty", rule["fileNamePrefix"])
	}
	if rule["daysFromHidingToDeleting"] != float64(1) {
		t.Fatalf("daysFromHidingToDeleting=%#v, want 1", rule["daysFromHidingToDeleting"])
	}
	if _, present := rule["daysFromUploadingToHiding"]; present {
		t.Fatal("daysFromUploadingToHiding must not be sent")
	}
}

// existingBucketServer serves authorize, a list with one existing bucket, and a key create.
// listRules are the lifecycle rules the existing bucket reports; updateStatus (0 = 200) is the
// status the b2_update_bucket call returns. updates counts update calls; created records a key create.
func existingBucketServer(t *testing.T, listRules any, updateStatus int, updates *int, created *bool) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/b2api/v2/b2_authorize_account":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"accountId":          "acc123",
				"authorizationToken": "tok123",
				"apiUrl":             "http://" + r.Host,
				"s3ApiUrl":           "https://s3.us-west-001.backblazeb2.com",
			})
		case strings.Contains(r.URL.Path, "b2_create_bucket"):
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(`{"code":"duplicate_bucket_name","message":"Bucket name is already in use"}`))
		case strings.Contains(r.URL.Path, "b2_list_buckets"):
			_ = json.NewEncoder(w).Encode(map[string]any{
				"buckets": []map[string]any{
					{"bucketId": "buc-existing", "bucketName": "luna-backup-dev-abc", "lifecycleRules": listRules},
				},
			})
		case strings.Contains(r.URL.Path, "b2_update_bucket"):
			*updates++
			body, _ := io.ReadAll(r.Body)
			var req map[string]any
			if err := json.Unmarshal(body, &req); err != nil {
				t.Fatalf("decode update body: %v", err)
			}
			if req["bucketId"] != "buc-existing" {
				t.Fatalf("update bucketId=%v", req["bucketId"])
			}
			assertKeepLastVersionRules(t, req["lifecycleRules"])
			if updateStatus != 0 {
				w.WriteHeader(updateStatus)
				_, _ = w.Write([]byte(`{"code":"service_unavailable","message":"try later"}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"bucketId":       "buc-existing",
				"bucketName":     "luna-backup-dev-abc",
				"lifecycleRules": keepLastVersionRules(),
			})
		case strings.Contains(r.URL.Path, "b2_create_key"):
			*created = true
			_ = json.NewEncoder(w).Encode(map[string]string{
				"applicationKeyId": "keyid-new",
				"applicationKey":   "appkey-new",
			})
		default:
			http.NotFound(w, r)
		}
	}))
}

// The rule an existing bucket already has, as B2 reports it on b2_list_buckets.
func keepLastVersionRulesJSON() []map[string]any {
	return []map[string]any{{"fileNamePrefix": "", "daysFromHidingToDeleting": 1}}
}

func TestB2ProvisionBucketSetsKeepLastVersionOnExistingBucket(t *testing.T) {
	var updates int
	var created bool
	ts := existingBucketServer(t, []map[string]any{}, 0, &updates, &created)
	defer ts.Close()

	client := NewB2Client(ts.Client())
	client.authorizeURL = ts.URL + "/b2api/v2/b2_authorize_account"
	creds, err := client.ProvisionBucket("acc123", "key456", "luna-backup-dev-abc")
	if err != nil {
		t.Fatalf("provision: %v", err)
	}
	if updates != 1 {
		t.Fatalf("b2_update_bucket calls=%d, want 1", updates)
	}
	if !created || creds.KeyID != "keyid-new" {
		t.Fatalf("expected a new key after the update, creds=%+v", creds)
	}
}

func TestB2ProvisionBucketSkipsUpdateWhenRulePresent(t *testing.T) {
	var updates int
	var created bool
	ts := existingBucketServer(t, keepLastVersionRulesJSON(), 0, &updates, &created)
	defer ts.Close()

	client := NewB2Client(ts.Client())
	client.authorizeURL = ts.URL + "/b2api/v2/b2_authorize_account"
	if _, err := client.ProvisionBucket("acc123", "key456", "luna-backup-dev-abc"); err != nil {
		t.Fatalf("provision: %v", err)
	}
	if updates != 0 {
		t.Fatalf("b2_update_bucket calls=%d, want 0 when the rule is already there", updates)
	}
	if !created {
		t.Fatal("expected a key create")
	}
}

func TestB2ProvisionBucketUpdatesWhenRulesDiffer(t *testing.T) {
	// A bucket whose only rule hides files after 7 days is not "already set": it is replaced.
	var updates int
	var created bool
	other := []map[string]any{{"fileNamePrefix": "", "daysFromHidingToDeleting": 7}}
	ts := existingBucketServer(t, other, 0, &updates, &created)
	defer ts.Close()

	client := NewB2Client(ts.Client())
	client.authorizeURL = ts.URL + "/b2api/v2/b2_authorize_account"
	if _, err := client.ProvisionBucket("acc123", "key456", "luna-backup-dev-abc"); err != nil {
		t.Fatalf("provision: %v", err)
	}
	if updates != 1 {
		t.Fatalf("b2_update_bucket calls=%d, want 1", updates)
	}
}

func TestB2ProvisionBucketSurvivesLifecycleUpdateError(t *testing.T) {
	// A failed rule update is a warning: the bucket works without it, so the backup can start.
	var updates int
	var created bool
	ts := existingBucketServer(t, []map[string]any{}, http.StatusServiceUnavailable, &updates, &created)
	defer ts.Close()

	client := NewB2Client(ts.Client())
	client.authorizeURL = ts.URL + "/b2api/v2/b2_authorize_account"
	creds, err := client.ProvisionBucket("acc123", "key456", "luna-backup-dev-abc")
	if err != nil {
		t.Fatalf("provision should still succeed: %v", err)
	}
	if updates != 1 {
		t.Fatalf("b2_update_bucket calls=%d, want 1", updates)
	}
	if !created || creds.KeyID != "keyid-new" {
		t.Fatalf("a key should still be created, creds=%+v", creds)
	}
}

func TestB2EnsureKeepLastVersionSendsRevision(t *testing.T) {
	var got map[string]any
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(body, &got)
		_ = json.NewEncoder(w).Encode(map[string]any{"bucketId": "b", "revision": 8})
	}))
	defer ts.Close()

	client := NewB2Client(ts.Client())
	bucket := &b2BucketResponse{BucketID: "b", Revision: 7}
	if err := client.EnsureKeepLastVersion(ts.URL, "tok", "acc", bucket); err != nil {
		t.Fatal(err)
	}
	if got["ifRevisionIs"] != float64(7) {
		t.Fatalf("ifRevisionIs=%v, want 7", got["ifRevisionIs"])
	}
	if bucket.Revision != 8 {
		t.Fatalf("revision=%d, want the one B2 returned", bucket.Revision)
	}

	// Without a known revision the field is left out.
	got = nil
	if err := client.EnsureKeepLastVersion(ts.URL, "tok", "acc", &b2BucketResponse{BucketID: "b"}); err != nil {
		t.Fatal(err)
	}
	if _, present := got["ifRevisionIs"]; present {
		t.Fatal("ifRevisionIs must be left out when the revision is unknown")
	}
}

func TestB2CreateBucketSendsKeepLastVersionRule(t *testing.T) {
	// Covered by TestB2ProvisionBucket's create handler; this checks the rule directly.
	rules := keepLastVersionRules()
	if len(rules) != 1 || rules[0].FileNamePrefix != "" || rules[0].DaysFromHidingToDeleting == nil ||
		*rules[0].DaysFromHidingToDeleting != 1 || rules[0].DaysFromUploadingToHiding != nil {
		t.Fatalf("rules=%+v", rules)
	}
	if !hasKeepLastVersionRules(rules) {
		t.Fatal("the rule should match itself")
	}
	if hasKeepLastVersionRules(nil) {
		t.Fatal("an empty rule list is not the keep-last-version rule")
	}
}
