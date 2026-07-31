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
type b2AuthResponse struct {
	AccountID          string `json:"accountId"`
	AuthorizationToken string `json:"authorizationToken"`
	APIURL             string `json:"apiUrl"`
	DownloadURL        string `json:"downloadUrl"`
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

	bucket, err := c.CreateBucket(auth.APIURL, auth.AuthorizationToken, auth.AccountID, bucketName, "allPrivate")
	if err != nil {
		return nil, err
	}

	key, err := c.CreateKey(auth.APIURL, auth.AuthorizationToken, auth.AccountID, bucketName+"-key", bucket.BucketID, nil)
	if err != nil {
		return nil, err
	}

	return &B2Credentials{
		Endpoint:   b2S3Endpoint(auth.APIURL),
		KeyID:      key.ApplicationKeyID,
		Key:        key.ApplicationKey,
		BucketName: bucket.BucketName,
	}, nil
}

var b2RegionRegex = regexp.MustCompile(`^[0-9]{3}$`)

// b2S3Endpoint derives the S3-compatible endpoint from a B2 API URL.
// A B2 API URL looks like https://apiNNN.backblazeb2.com; the matching S3 endpoint is
// s3.NNN.backblazeb2.com.
func b2S3Endpoint(apiURL string) string {
	apiURL = strings.TrimPrefix(strings.TrimPrefix(apiURL, "https://"), "http://")
	apiURL = strings.TrimSuffix(apiURL, "/")
	region := strings.TrimPrefix(apiURL, "api")
	region = strings.TrimSuffix(region, ".backblazeb2.com")
	if region == "" || region == apiURL || !b2RegionRegex.MatchString(region) {
		return "s3.backblazeb2.com"
	}
	return "s3." + region + ".backblazeb2.com"
}
