package providers

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// authCacheTTL is how long a b2_authorize_account result is reused. B2 tokens last 24 hours;
// a short TTL keeps a revoked key from lingering while sparing a sign-in on every pack.
const authCacheTTL = 20 * time.Minute

// B2Credentials holds S3-compatible values for a single device bucket.
type B2Credentials struct {
	Endpoint   string `json:"endpoint"`
	KeyID      string `json:"key_id"`
	Key        string `json:"key"`
	BucketName string `json:"bucket_name"`
	BucketID   string `json:"bucket_id"`
}

// B2Client talks to the Backblaze B2 API.
type B2Client struct {
	httpClient   *http.Client
	authorizeURL string

	mu    sync.Mutex
	cache map[string]cachedAuth
}

type cachedAuth struct {
	auth *b2AuthResponse
	at   time.Time
}

// NewB2Client creates a B2 client with the given HTTP client or a default 15s timeout client.
func NewB2Client(httpClient *http.Client) *B2Client {
	if httpClient == nil {
		httpClient = defaultHTTPClient()
	}
	return &B2Client{httpClient: httpClient}
}

// SetAuthorizeURLForTest overrides the authorize endpoint. For unit tests only.
func SetAuthorizeURLForTest(c *B2Client, u string) {
	if c != nil {
		c.authorizeURL = u
	}
}

// b2AuthResponse is the body returned by b2_authorize_account.
// Recent (v4) responses nest the storage API fields under apiInfo.storageApi;
// older responses keep apiUrl/downloadUrl/s3ApiUrl at the top level.
type b2AuthResponse struct {
	AccountID          string    `json:"accountId"`
	AuthorizationToken string    `json:"authorizationToken"`
	APIURL             string    `json:"apiUrl"`
	DownloadURL        string    `json:"downloadUrl"`
	S3APIURL           string    `json:"s3ApiUrl"`
	APIInfo            b2APIInfo `json:"apiInfo"`
}

type b2APIInfo struct {
	StorageAPI b2StorageAPI `json:"storageApi"`
}

type b2StorageAPI struct {
	APIURL      string `json:"apiUrl"`
	DownloadURL string `json:"downloadUrl"`
	S3APIURL    string `json:"s3ApiUrl"`
}

func (r *b2AuthResponse) normalize() {
	if r.APIURL == "" {
		r.APIURL = r.APIInfo.StorageAPI.APIURL
	}
	if r.S3APIURL == "" {
		r.S3APIURL = r.APIInfo.StorageAPI.S3APIURL
	}
	if r.DownloadURL == "" {
		r.DownloadURL = r.APIInfo.StorageAPI.DownloadURL
	}
}

type b2BucketResponse struct {
	BucketID       string            `json:"bucketId"`
	BucketName     string            `json:"bucketName"`
	LifecycleRules []b2LifecycleRule `json:"lifecycleRules"`
	// Revision changes every time B2 updates the bucket. Sending it back as ifRevisionIs makes
	// an update fail instead of overwriting a change made in between.
	Revision int64 `json:"revision"`
}

// b2LifecycleRule is one B2 file lifecycle rule. fileNamePrefix "" applies to every file.
type b2LifecycleRule struct {
	FileNamePrefix            string `json:"fileNamePrefix"`
	DaysFromHidingToDeleting  *int   `json:"daysFromHidingToDeleting,omitempty"`
	DaysFromUploadingToHiding *int   `json:"daysFromUploadingToHiding,omitempty"`
}

// keepLastVersionRules keeps only the newest version of each file. A file that is overwritten is
// hidden at once and deleted a day later, so an old phrase's copy does not stay billed forever.
func keepLastVersionRules() []b2LifecycleRule {
	days := 1
	return []b2LifecycleRule{{FileNamePrefix: "", DaysFromHidingToDeleting: &days}}
}

// hasKeepLastVersionRules reports whether a bucket's rules are exactly keepLastVersionRules.
func hasKeepLastVersionRules(rules []b2LifecycleRule) bool {
	want := keepLastVersionRules()
	if len(rules) != len(want) {
		return false
	}
	for i := range rules {
		got, exp := rules[i], want[i]
		if got.FileNamePrefix != exp.FileNamePrefix || got.DaysFromUploadingToHiding != nil ||
			got.DaysFromHidingToDeleting == nil || *got.DaysFromHidingToDeleting != *exp.DaysFromHidingToDeleting {
			return false
		}
	}
	return true
}

type b2KeyResponse struct {
	ApplicationKeyID string `json:"applicationKeyId"`
	ApplicationKey   string `json:"applicationKey"`
}

type b2ListBucketsResponse struct {
	Buckets []b2BucketResponse `json:"buckets"`
}

func authCacheKey(accountID, applicationKey string) string {
	sum := sha256.Sum256([]byte(applicationKey))
	return accountID + "\x00" + hex.EncodeToString(sum[:])
}

// Authorize calls b2_authorize_account, reusing a recent result for the same key.
func (c *B2Client) Authorize(accountID, applicationKey string) (*b2AuthResponse, error) {
	ck := authCacheKey(accountID, applicationKey)
	c.mu.Lock()
	if e, ok := c.cache[ck]; ok && time.Since(e.at) < authCacheTTL {
		c.mu.Unlock()
		return e.auth, nil
	}
	c.mu.Unlock()

	resp, err := c.authorizeFresh(accountID, applicationKey)
	if err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.cache == nil {
		c.cache = map[string]cachedAuth{}
	}
	c.cache[ck] = cachedAuth{auth: resp, at: time.Now()}
	c.mu.Unlock()
	return resp, nil
}

// forgetAuth drops a cached sign-in, so the next call signs in again. Call it when B2 refuses a token.
func (c *B2Client) forgetAuth(accountID, applicationKey string) {
	c.mu.Lock()
	delete(c.cache, authCacheKey(accountID, applicationKey))
	c.mu.Unlock()
}

func (c *B2Client) authorizeFresh(accountID, applicationKey string) (*b2AuthResponse, error) {
	auth := base64.StdEncoding.EncodeToString([]byte(accountID + ":" + applicationKey))
	url := c.authorizeURL
	if url == "" {
		url = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account"
	}
	var resp b2AuthResponse
	if err := doJSON(c.httpClient, http.MethodPost, url, map[string]string{
		"Authorization": "Basic " + auth,
	}, map[string]string{}, &resp); err != nil {
		return nil, fmt.Errorf("could not authorize with Backblaze B2: %w", err)
	}
	resp.normalize()
	return &resp, nil
}

// CreateBucket creates a private B2 bucket that keeps only the last version of each file.
func (c *B2Client) CreateBucket(apiURL, authToken, accountID, name, bucketType string) (*b2BucketResponse, error) {
	if bucketType == "" {
		bucketType = "allPrivate"
	}
	url := strings.TrimRight(apiURL, "/") + "/b2api/v2/b2_create_bucket"
	var resp b2BucketResponse
	if err := doJSON(c.httpClient, http.MethodPost, url, map[string]string{
		"Authorization": authToken,
	}, map[string]any{
		"accountId":      accountID,
		"bucketName":     name,
		"bucketType":     bucketType,
		"lifecycleRules": keepLastVersionRules(),
	}, &resp); err != nil {
		return nil, fmt.Errorf("could not create Backblaze B2 bucket: %w", err)
	}
	resp.BucketName = name
	return &resp, nil
}

// EnsureKeepLastVersion applies the keep-last-version rule to an existing bucket. It does nothing
// when the bucket already has exactly that rule, so it is safe to call on every provision.
//
// Any other lifecycle rules on the bucket are REPLACED by the one rule: B2 sets the whole list at
// once. Luna's buckets hold only Luna's own files, so nothing else is expected there. When B2
// reported the bucket's revision, it is sent as ifRevisionIs, so a bucket changed since it was read
// is refused rather than overwritten; the caller can read it again and retry.
func (c *B2Client) EnsureKeepLastVersion(apiURL, authToken, accountID string, bucket *b2BucketResponse) error {
	if hasKeepLastVersionRules(bucket.LifecycleRules) {
		return nil
	}
	url := strings.TrimRight(apiURL, "/") + "/b2api/v2/b2_update_bucket"
	var resp b2BucketResponse
	update := map[string]any{
		"accountId":      accountID,
		"bucketId":       bucket.BucketID,
		"lifecycleRules": keepLastVersionRules(),
	}
	if bucket.Revision > 0 {
		update["ifRevisionIs"] = bucket.Revision
	}
	if err := doJSON(c.httpClient, http.MethodPost, url, map[string]string{
		"Authorization": authToken,
	}, update, &resp); err != nil {
		return fmt.Errorf("could not set Backblaze B2 bucket to keep only the last version: %w", err)
	}
	bucket.LifecycleRules = keepLastVersionRules()
	if resp.Revision > 0 {
		bucket.Revision = resp.Revision
	}
	return nil
}

// EnsureKeepLastVersionByName applies the keep-last-version rule to the existing bucket called
// name, using the account's master key. Use it for buckets provisioned before the rule existed.
func (c *B2Client) EnsureKeepLastVersionByName(accountID, applicationKey, name string) error {
	auth, err := c.Authorize(accountID, applicationKey)
	if err != nil {
		return err
	}
	bucket, err := c.findBucket(auth.APIURL, auth.AuthorizationToken, auth.AccountID, name)
	if err != nil {
		return err
	}
	if bucket == nil {
		return fmt.Errorf("Backblaze B2 bucket %s was not found", name)
	}
	return c.EnsureKeepLastVersion(auth.APIURL, auth.AuthorizationToken, auth.AccountID, bucket)
}

// ListBuckets returns all buckets on the account.
func (c *B2Client) ListBuckets(apiURL, authToken, accountID string) ([]b2BucketResponse, error) {
	url := strings.TrimRight(apiURL, "/") + "/b2api/v2/b2_list_buckets"
	var resp b2ListBucketsResponse
	if err := doJSON(c.httpClient, http.MethodPost, url, map[string]string{
		"Authorization": authToken,
	}, map[string]string{
		"accountId": accountID,
	}, &resp); err != nil {
		return nil, fmt.Errorf("could not list Backblaze B2 buckets: %w", err)
	}
	return resp.Buckets, nil
}

// CreateKey creates an application key limited to a bucket and capabilities.
func (c *B2Client) CreateKey(apiURL, authToken, accountID, name, bucketID string, capabilities []string) (*b2KeyResponse, error) {
	if len(capabilities) == 0 {
		capabilities = []string{"listBuckets", "listFiles", "readFiles", "writeFiles", "deleteFiles"}
	}
	url := strings.TrimRight(apiURL, "/") + "/b2api/v2/b2_create_key"
	var resp b2KeyResponse
	if err := doJSON(c.httpClient, http.MethodPost, url, map[string]string{
		"Authorization": authToken,
	}, map[string]any{
		"accountId":    accountID,
		"keyName":      name,
		"bucketId":     bucketID,
		"capabilities": capabilities,
	}, &resp); err != nil {
		return nil, fmt.Errorf("could not create Backblaze B2 application key: %w", err)
	}
	return &resp, nil
}

// DeleteKey revokes an application key. A key that is already gone counts as revoked.
func (c *B2Client) DeleteKey(accountID, applicationKey, keyID string) error {
	auth, err := c.Authorize(accountID, applicationKey)
	if err != nil {
		return err
	}
	url := strings.TrimRight(auth.APIURL, "/") + "/b2api/v2/b2_delete_key"
	if err := doJSON(c.httpClient, http.MethodPost, url, map[string]string{
		"Authorization": auth.AuthorizationToken,
	}, map[string]string{"applicationKeyId": keyID}, nil); err != nil {
		if strings.Contains(err.Error(), "no_such_key") {
			return nil
		}
		return fmt.Errorf("could not delete Backblaze B2 application key: %w", err)
	}
	return nil
}

// DeleteBucket removes an empty bucket. B2 refuses a bucket that still holds files.
func (c *B2Client) DeleteBucket(accountID, applicationKey, bucketID string) error {
	auth, err := c.Authorize(accountID, applicationKey)
	if err != nil {
		return err
	}
	url := strings.TrimRight(auth.APIURL, "/") + "/b2api/v2/b2_delete_bucket"
	if err := doJSON(c.httpClient, http.MethodPost, url, map[string]string{
		"Authorization": auth.AuthorizationToken,
	}, map[string]string{"accountId": auth.AccountID, "bucketId": bucketID}, nil); err != nil {
		if strings.Contains(err.Error(), "bad_bucket_id") {
			return nil
		}
		return fmt.Errorf("could not delete Backblaze B2 bucket: %w", err)
	}
	return nil
}

// ProvisionBucket creates (or reuses) a private bucket and a bucket-scoped application key.
// Idempotent on bucket name: if the bucket already exists, a new key is created for it.
func (c *B2Client) ProvisionBucket(accountID, applicationKey, bucketName string) (*B2Credentials, error) {
	auth, err := c.Authorize(accountID, applicationKey)
	if err != nil {
		return nil, err
	}

	endpoint, err := s3EndpointFor(auth)
	if err != nil {
		return nil, fmt.Errorf("could not determine B2 S3 endpoint: %w", err)
	}

	bucket, err := c.CreateBucket(auth.APIURL, auth.AuthorizationToken, auth.AccountID, bucketName, "allPrivate")
	if err != nil {
		if !isDuplicateBucketErr(err) {
			return nil, err
		}
		existing, findErr := c.findBucket(auth.APIURL, auth.AuthorizationToken, auth.AccountID, bucketName)
		if findErr != nil {
			return nil, findErr
		}
		if existing == nil {
			return nil, fmt.Errorf("Backblaze B2 reported the bucket already exists, but it was not found: %s", bucketName)
		}
		// Best effort: the master key is in use and the bucket works without the rule, so a
		// backup can still start. The rule is tried again the next time this Luna asks for its bucket.
		if err := c.EnsureKeepLastVersion(auth.APIURL, auth.AuthorizationToken, auth.AccountID, existing); err != nil {
			slog.Warn("backup bucket: could not set keep-last-version", "bucket", bucketName, "error", err)
		}
		bucket = existing
	}

	keyName := bucketName + "-key-" + randomHex(8)
	key, err := c.CreateKey(auth.APIURL, auth.AuthorizationToken, auth.AccountID, keyName, bucket.BucketID, nil)
	if err != nil {
		return nil, err
	}

	return &B2Credentials{
		Endpoint:   endpoint,
		KeyID:      key.ApplicationKeyID,
		Key:        key.ApplicationKey,
		BucketName: bucket.BucketName,
		BucketID:   bucket.BucketID,
	}, nil
}

func (c *B2Client) findBucket(apiURL, authToken, accountID, name string) (*b2BucketResponse, error) {
	buckets, err := c.ListBuckets(apiURL, authToken, accountID)
	if err != nil {
		return nil, err
	}
	for i := range buckets {
		if buckets[i].BucketName == name {
			return &buckets[i], nil
		}
	}
	return nil, nil
}

func isDuplicateBucketErr(err error) bool {
	if err == nil {
		return false
	}
	msg := strings.ToLower(err.Error())
	return strings.Contains(msg, "duplicate_bucket_name") ||
		strings.Contains(msg, "bucket name is already in use") ||
		strings.Contains(msg, "already exists")
}

var b2RegionRegex = regexp.MustCompile(`^[0-9]{3}$`)

func s3EndpointFor(auth *b2AuthResponse) (string, error) {
	if ep := strings.TrimSuffix(auth.S3APIURL, "/"); ep != "" {
		return ep, nil
	}
	return b2S3Endpoint(auth.APIURL)
}

// b2S3Endpoint derives a legacy S3-compatible endpoint from a B2 API URL.
func b2S3Endpoint(apiURL string) (string, error) {
	apiURL = strings.TrimPrefix(strings.TrimPrefix(apiURL, "https://"), "http://")
	apiURL = strings.TrimSuffix(apiURL, "/")
	region := strings.TrimPrefix(apiURL, "api")
	region = strings.TrimSuffix(region, ".backblazeb2.com")
	if region == "" || region == apiURL || !b2RegionRegex.MatchString(region) {
		return "", fmt.Errorf("cannot derive S3 endpoint from B2 API URL %q (authorize response had no s3ApiUrl)", apiURL)
	}
	return "s3.us-west-" + region + ".backblazeb2.com", nil
}

func randomHex(n int) string {
	b := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}
