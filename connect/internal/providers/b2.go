package providers

import (
	"encoding/base64"
	"fmt"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// B2Credentials holds the values needed for restic to back up to Backblaze B2.
type B2Credentials struct {
	Endpoint   string `json:"endpoint"`
	KeyID      string `json:"key_id"`
	Key        string `json:"key"`
	BucketName string `json:"bucket_name"`
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

// b2APIInfo is the v4 response container for per-API information.
type b2APIInfo struct {
	StorageAPI b2StorageAPI `json:"storageApi"`
}

// b2StorageAPI carries the storage API endpoints in the v4 response shape.
type b2StorageAPI struct {
	APIURL      string `json:"apiUrl"`
	DownloadURL string `json:"downloadUrl"`
	S3APIURL    string `json:"s3ApiUrl"`
}

// normalize promotes the v4 nested shape into the flat fields so callers can
// rely on APIURL/S3APIURL regardless of the response version.
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

// b2BucketResponse is the body returned by b2_create_bucket.
type b2BucketResponse struct {
	BucketID   string `json:"bucketId"`
	BucketName string `json:"bucketName"`
}

// b2KeyResponse is the body returned by b2_create_key.
type b2KeyResponse struct {
	ApplicationKeyID string `json:"applicationKeyId"`
	ApplicationKey   string `json:"applicationKey"`
}

func (c *B2Client) Authorize(accountID, applicationKey string) (*b2AuthResponse, error) {
	auth := base64.StdEncoding.EncodeToString([]byte(accountID + ":" + applicationKey))
	url := c.authorizeURL
	if url == "" {
		url = "https://api.backblazeb2.com/b2api/v2/b2_authorize_account"
	}
	var resp b2AuthResponse
	if _, err := doJSON(c.httpClient, http.MethodPost, url, map[string]string{
		"Authorization": "Basic " + auth,
	}, map[string]string{}, &resp); err != nil {
		return nil, fmt.Errorf("could not authorize with Backblaze B2: %w", err)
	}
	resp.normalize()
	return &resp, nil
}

func (c *B2Client) CreateBucket(apiURL, authToken, accountID, name, bucketType string) (*b2BucketResponse, error) {
	if bucketType == "" {
		bucketType = "allPrivate"
	}
	url := strings.TrimRight(apiURL, "/") + "/b2api/v2/b2_create_bucket"
	var resp b2BucketResponse
	if _, err := doJSON(c.httpClient, http.MethodPost, url, map[string]string{
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

// CreateKey creates an application key limited to a bucket and capabilities.
func (c *B2Client) CreateKey(apiURL, authToken, accountID, name, bucketID string, capabilities []string) (*b2KeyResponse, error) {
	if len(capabilities) == 0 {
		capabilities = []string{"listBuckets", "listFiles", "readFiles", "writeFiles", "deleteFiles"}
	}
	url := strings.TrimRight(apiURL, "/") + "/b2api/v2/b2_create_key"
	var resp b2KeyResponse
	if _, err := doJSON(c.httpClient, http.MethodPost, url, map[string]string{
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

func (c *B2Client) ProvisionBucket(accountID, applicationKey, bucketName string) (*B2Credentials, error) {
	auth, err := c.Authorize(accountID, applicationKey)
	if err != nil {
		return nil, err
	}

	// Resolve the S3 endpoint before creating anything on the account, so a
	// malformed response fails without leaving a half-provisioned bucket/key.
	endpoint, err := s3EndpointFor(auth)
	if err != nil {
		return nil, fmt.Errorf("could not determine B2 S3 endpoint: %w", err)
	}

	bucket, err := c.CreateBucket(auth.APIURL, auth.AuthorizationToken, auth.AccountID, bucketName, "allPrivate")
	if err != nil {
		return nil, err
	}

	key, err := c.CreateKey(auth.APIURL, auth.AuthorizationToken, auth.AccountID, bucketName+"-key", bucket.BucketID, nil)
	if err != nil {
		return nil, err
	}

	return &B2Credentials{
		Endpoint:   endpoint,
		KeyID:      key.ApplicationKeyID,
		Key:        key.ApplicationKey,
		BucketName: bucket.BucketName,
	}, nil
}

var b2RegionRegex = regexp.MustCompile(`^[0-9]{3}$`)

// s3EndpointFor picks the S3-compatible endpoint for a bucket. The authoritative
// s3ApiUrl returned by b2_authorize_account wins when present; otherwise the
// legacy apiNNN derivation is used as a fallback.
func s3EndpointFor(auth *b2AuthResponse) (string, error) {
	if ep := strings.TrimSuffix(auth.S3APIURL, "/"); ep != "" {
		return ep, nil
	}
	return b2S3Endpoint(auth.APIURL)
}

// b2S3Endpoint derives a legacy S3-compatible endpoint from a B2 API URL of the
// form https://apiNNN.backblazeb2.com, mapping the datacenter number onto the
// us-west region (e.g. api001 → s3.us-west-001.backblazeb2.com, matching
// Backblaze's own authorize response example). It is only a fallback for
// responses that omit s3ApiUrl. It returns an error instead of guessing a
// hostname when the URL has an unexpected shape.
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
