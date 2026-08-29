package providers

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

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
}

// NewB2Client creates a B2 client with the given HTTP client or a default 15s timeout client.
func NewB2Client(httpClient *http.Client) *B2Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 15 * time.Second}
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
	BucketID   string `json:"bucketId"`
	BucketName string `json:"bucketName"`
}

type b2KeyResponse struct {
	ApplicationKeyID string `json:"applicationKeyId"`
	ApplicationKey   string `json:"applicationKey"`
}

type b2ListBucketsResponse struct {
	Buckets []b2BucketResponse `json:"buckets"`
}

// Authorize calls b2_authorize_account with the master application key.
func (c *B2Client) Authorize(accountID, applicationKey string) (*b2AuthResponse, error) {
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

// CreateBucket creates a private B2 bucket.
func (c *B2Client) CreateBucket(apiURL, authToken, accountID, name, bucketType string) (*b2BucketResponse, error) {
	if bucketType == "" {
		bucketType = "allPrivate"
	}
	url := strings.TrimRight(apiURL, "/") + "/b2api/v2/b2_create_bucket"
	var resp b2BucketResponse
	if err := doJSON(c.httpClient, http.MethodPost, url, map[string]string{
		"Authorization": authToken,
	}, map[string]string{
		"accountId":  accountID,
		"bucketName": name,
		"bucketType": bucketType,
	}, &resp); err != nil {
		return nil, fmt.Errorf("could not create Backblaze B2 bucket: %w", err)
	}
	resp.BucketName = name
	return &resp, nil
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
