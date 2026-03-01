package cloud

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type BackblazeProvider struct {
	keyID       string
	keySecret   string
	bucket      string
	authToken   string
	apiURL      string
	uploadURL   string
	downloadURL string
	accountID   string
}

type b2AuthResponse struct {
	AccountID          string `json:"accountId"`
	APIURL             string `json:"apiUrl"`
	AuthorizationToken string `json:"authorizationToken"`
	DownloadURL        string `json:"downloadUrl"`
}

type b2BucketResponse struct {
	BucketID   string `json:"bucketId"`
	BucketName string `json:"bucketName"`
	BucketType string `json:"bucketType"`
}

type b2UploadURLResponse struct {
	BucketID           string `json:"bucketId"`
	UploadURL          string `json:"uploadUrl"`
	AuthorizationToken string `json:"authorizationToken"`
}

type b2UploadResponse struct {
	FileID   string `json:"fileId"`
	FileName string `json:"fileName"`
}

type b2ListResponse struct {
	Files []b2File `json:"files"`
}

type b2File struct {
	FileID      string `json:"fileId"`
	FileName    string `json:"fileName"`
	Size        int64  `json:"size"`
	UploadToken string `json:"uploadTimestamp"`
}

func NewBackblazeProvider(keyID, keySecret, bucket string) *BackblazeProvider {
	return &BackblazeProvider{
		keyID:     keyID,
		keySecret: keySecret,
		bucket:    bucket,
	}
}

func (p *BackblazeProvider) GetProviderName() Provider {
	return ProviderBackblaze
}

func (p *BackblazeProvider) authorize(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, "GET", "https://api.backblazeb2.com/b2api/v2/b2_authorize_account", nil)
	if err != nil {
		return fmt.Errorf("failed to create auth request: %w", err)
	}

	req.SetBasicAuth(p.keyID, p.keySecret)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("authorization failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("authorization failed (status %d): %s", resp.StatusCode, string(body))
	}

	var authResp b2AuthResponse
	if err := json.NewDecoder(resp.Body).Decode(&authResp); err != nil {
		return fmt.Errorf("failed to decode auth response: %w", err)
	}

	p.authToken = authResp.AuthorizationToken
	p.apiURL = authResp.APIURL
	p.downloadURL = authResp.DownloadURL
	p.accountID = authResp.AccountID

	return nil
}

func (p *BackblazeProvider) getBucketID(ctx context.Context) (string, error) {
	if p.authToken == "" {
		if err := p.authorize(ctx); err != nil {
			return "", err
		}
	}

	url := fmt.Sprintf("%s/b2api/v2/b2_list_buckets?accountId=%s&bucketName=%s", p.apiURL, p.accountID, p.bucket)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return "", fmt.Errorf("failed to create bucket request: %w", err)
	}

	req.Header.Set("Authorization", p.authToken)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("bucket lookup failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return "", fmt.Errorf("bucket lookup failed (status %d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		Buckets []b2BucketResponse `json:"buckets"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("failed to decode bucket response: %w", err)
	}

	if len(result.Buckets) == 0 {
		return "", fmt.Errorf("bucket %s not found", p.bucket)
	}

	return result.Buckets[0].BucketID, nil
}

func (p *BackblazeProvider) getUploadURL(ctx context.Context) error {
	bucketID, err := p.getBucketID(ctx)
	if err != nil {
		return err
	}

	url := fmt.Sprintf("%s/b2api/v2/b2_get_upload_url?bucketId=%s", p.apiURL, bucketID)
	req, err := http.NewRequestWithContext(ctx, "GET", url, nil)
	if err != nil {
		return fmt.Errorf("failed to create upload URL request: %w", err)
	}

	req.Header.Set("Authorization", p.authToken)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("upload URL request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upload URL request failed (status %d): %s", resp.StatusCode, string(body))
	}

	var uploadResp b2UploadURLResponse
	if err := json.NewDecoder(resp.Body).Decode(&uploadResp); err != nil {
		return fmt.Errorf("failed to decode upload URL response: %w", err)
	}

	p.uploadURL = uploadResp.UploadURL
	p.authToken = uploadResp.AuthorizationToken

	return nil
}

func (p *BackblazeProvider) TestConnection(ctx context.Context) error {
	if err := p.authorize(ctx); err != nil {
		return err
	}

	_, err := p.getBucketID(ctx)
	if err != nil {
		return err
	}

	return nil
}

func (p *BackblazeProvider) Upload(ctx context.Context, localPath, remotePath string) error {
	if p.authToken == "" {
		if err := p.authorize(ctx); err != nil {
			return err
		}
	}

	if err := p.getUploadURL(ctx); err != nil {
		return err
	}

	file, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("failed to open local file: %w", err)
	}
	defer file.Close()

	fileInfo, err := file.Stat()
	if err != nil {
		return fmt.Errorf("failed to get file info: %w", err)
	}

	hash := sha1.New()
	if _, err := io.Copy(hash, file); err != nil {
		return fmt.Errorf("failed to calculate SHA1: %w", err)
	}
	file.Seek(0, 0)

	sha1Hash := fmt.Sprintf("%x", hash.Sum(nil))

	req, err := http.NewRequestWithContext(ctx, "POST", p.uploadURL, file)
	if err != nil {
		return fmt.Errorf("failed to create upload request: %w", err)
	}

	req.Header.Set("Authorization", p.authToken)
	req.Header.Set("X-Bz-File-Name", url.PathEscape(remotePath))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Bz-Content-Sha1", sha1Hash)
	req.ContentLength = fileInfo.Size()

	client := &http.Client{Timeout: 30 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("upload failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("upload failed (status %d): %s", resp.StatusCode, string(body))
	}

	var uploadResp b2UploadResponse
	if err := json.NewDecoder(resp.Body).Decode(&uploadResp); err != nil {
		return fmt.Errorf("failed to decode upload response: %w", err)
	}

	return nil
}

func (p *BackblazeProvider) Download(ctx context.Context, remotePath, localPath string) error {
	if p.authToken == "" {
		if err := p.authorize(ctx); err != nil {
			return err
		}
	}

	downloadURL := fmt.Sprintf("%s/file/%s/%s", p.downloadURL, p.bucket, url.PathEscape(remotePath))
	req, err := http.NewRequestWithContext(ctx, "GET", downloadURL, nil)
	if err != nil {
		return fmt.Errorf("failed to create download request: %w", err)
	}

	req.Header.Set("Authorization", p.authToken)

	client := &http.Client{Timeout: 30 * time.Minute}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("download failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("download failed (status %d): %s", resp.StatusCode, string(body))
	}

	if err := os.MkdirAll(filepath.Dir(localPath), 0755); err != nil {
		return fmt.Errorf("failed to create local directory: %w", err)
	}

	file, err := os.Create(localPath)
	if err != nil {
		return fmt.Errorf("failed to create local file: %w", err)
	}
	defer file.Close()

	if _, err := io.Copy(file, resp.Body); err != nil {
		return fmt.Errorf("failed to write local file: %w", err)
	}

	return nil
}

func (p *BackblazeProvider) Delete(ctx context.Context, remotePath string) error {
	if p.authToken == "" {
		if err := p.authorize(ctx); err != nil {
			return err
		}
	}

	bucketID, err := p.getBucketID(ctx)
	if err != nil {
		return err
	}

	listURL := fmt.Sprintf("%s/b2api/v2/b2_list_file_names?bucketId=%s&prefix=%s", p.apiURL, bucketID, url.QueryEscape(remotePath))
	req, err := http.NewRequestWithContext(ctx, "GET", listURL, nil)
	if err != nil {
		return fmt.Errorf("failed to create list request: %w", err)
	}

	req.Header.Set("Authorization", p.authToken)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("list files failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("list files failed (status %d): %s", resp.StatusCode, string(body))
	}

	var listResp b2ListResponse
	if err := json.NewDecoder(resp.Body).Decode(&listResp); err != nil {
		return fmt.Errorf("failed to decode list response: %w", err)
	}

	for _, file := range listResp.Files {
		if file.FileName == remotePath {
			deleteURL := fmt.Sprintf("%s/b2api/v2/b2_delete_file_version", p.apiURL)
			body := map[string]string{
				"fileId":   file.FileID,
				"fileName": file.FileName,
			}
			bodyBytes, _ := json.Marshal(body)

			req, err := http.NewRequestWithContext(ctx, "POST", deleteURL, bytes.NewReader(bodyBytes))
			if err != nil {
				return fmt.Errorf("failed to create delete request: %w", err)
			}

			req.Header.Set("Authorization", p.authToken)
			req.Header.Set("Content-Type", "application/json")

			resp, err := client.Do(req)
			if err != nil {
				return fmt.Errorf("delete failed: %w", err)
			}
			resp.Body.Close()
		}
	}

	return nil
}

func (p *BackblazeProvider) ListBackups(ctx context.Context, prefix string) ([]RemoteBackup, error) {
	if p.authToken == "" {
		if err := p.authorize(ctx); err != nil {
			return nil, err
		}
	}

	bucketID, err := p.getBucketID(ctx)
	if err != nil {
		return nil, err
	}

	listURL := fmt.Sprintf("%s/b2api/v2/b2_list_file_names?bucketId=%s&prefix=%s", p.apiURL, bucketID, url.QueryEscape(prefix))
	req, err := http.NewRequestWithContext(ctx, "GET", listURL, nil)
	if err != nil {
		return nil, fmt.Errorf("failed to create list request: %w", err)
	}

	req.Header.Set("Authorization", p.authToken)

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("list files failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("list files failed (status %d): %s", resp.StatusCode, string(body))
	}

	var listResp b2ListResponse
	if err := json.NewDecoder(resp.Body).Decode(&listResp); err != nil {
		return nil, fmt.Errorf("failed to decode list response: %w", err)
	}

	var backups []RemoteBackup
	for _, file := range listResp.Files {
		backupID := strings.TrimSuffix(filepath.Base(file.FileName), filepath.Ext(file.FileName))
		backupID = strings.TrimPrefix(backupID, "libreserv-")

		var uploadedAt time.Time
		if file.UploadToken != "" {
			ms, _ := json.Number(file.UploadToken).Int64()
			uploadedAt = time.UnixMilli(ms)
		}

		backups = append(backups, RemoteBackup{
			ID:         file.FileID,
			BackupID:   backupID,
			RemotePath: file.FileName,
			Size:       file.Size,
			UploadedAt: uploadedAt,
		})
	}

	return backups, nil
}
