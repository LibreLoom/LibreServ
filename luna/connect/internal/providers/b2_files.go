package providers

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"
)

type b2UploadURLResponse struct {
	BucketID           string `json:"bucketId"`
	UploadURL          string `json:"uploadUrl"`
	AuthorizationToken string `json:"authorizationToken"`
}

type b2ListFilesResponse struct {
	Files []b2FileVersion `json:"files"`
}

type b2FileVersion struct {
	FileID   string `json:"fileId"`
	FileName string `json:"fileName"`
}

// UploadFile uploads bytes to a B2 bucket using a bucket-scoped application key.
// fileName is the object key inside the bucket (forward-slash paths OK).
func (c *B2Client) UploadFile(accountID, applicationKey, bucketID, fileName string, body io.Reader, size int64, sha1Hex string) error {
	auth, err := c.Authorize(accountID, applicationKey)
	if err != nil {
		return err
	}
	upload, err := c.getUploadURL(auth.APIURL, auth.AuthorizationToken, bucketID)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, upload.UploadURL, body)
	if err != nil {
		return err
	}
	req.ContentLength = size
	req.Header.Set("Authorization", upload.AuthorizationToken)
	req.Header.Set("X-Bz-File-Name", b2EncodeFileName(fileName))
	req.Header.Set("Content-Type", "application/octet-stream")
	req.Header.Set("X-Bz-Content-Sha1", sha1Hex)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("could not upload to Backblaze B2: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return fmt.Errorf("could not upload to Backblaze B2: status %d: %s", resp.StatusCode, string(raw))
	}
	return nil
}

func (c *B2Client) getUploadURL(apiURL, authToken, bucketID string) (*b2UploadURLResponse, error) {
	endpoint := strings.TrimRight(apiURL, "/") + "/b2api/v2/b2_get_upload_url"
	var resp b2UploadURLResponse
	if err := doJSON(c.httpClient, http.MethodPost, endpoint, map[string]string{
		"Authorization": authToken,
	}, map[string]string{"bucketId": bucketID}, &resp); err != nil {
		return nil, fmt.Errorf("could not get Backblaze B2 upload URL: %w", err)
	}
	return &resp, nil
}

// DownloadFile opens a streaming read of a B2 object. Caller must Close the body.
func (c *B2Client) DownloadFile(accountID, applicationKey, bucketName, fileName string) (io.ReadCloser, error) {
	auth, err := c.Authorize(accountID, applicationKey)
	if err != nil {
		return nil, err
	}
	dl := strings.TrimRight(auth.DownloadURL, "/") + "/file/" + url.PathEscape(bucketName) + "/" + b2PathEscape(fileName)
	req, err := http.NewRequest(http.MethodGet, dl, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", auth.AuthorizationToken)
	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("could not download from Backblaze B2: %w", err)
	}
	if resp.StatusCode == http.StatusNotFound {
		resp.Body.Close()
		return nil, fmt.Errorf("file not found")
	}
	if resp.StatusCode >= 400 {
		raw, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		return nil, fmt.Errorf("could not download from Backblaze B2: status %d: %s", resp.StatusCode, string(raw))
	}
	return resp.Body, nil
}

// DeleteFile removes all versions of a file name from a B2 bucket.
func (c *B2Client) DeleteFile(accountID, applicationKey, bucketID, fileName string) error {
	auth, err := c.Authorize(accountID, applicationKey)
	if err != nil {
		return err
	}
	for {
		files, err := c.listFileVersions(auth.APIURL, auth.AuthorizationToken, bucketID, fileName)
		if err != nil {
			return err
		}
		if len(files) == 0 {
			return nil
		}
		for _, f := range files {
			if err := c.deleteFileVersion(auth.APIURL, auth.AuthorizationToken, f.FileID, f.FileName); err != nil {
				return err
			}
		}
		if len(files) < 100 {
			return nil
		}
	}
}

func (c *B2Client) listFileVersions(apiURL, authToken, bucketID, fileName string) ([]b2FileVersion, error) {
	u := strings.TrimRight(apiURL, "/") + "/b2api/v2/b2_list_file_versions"
	var resp b2ListFilesResponse
	if err := doJSON(c.httpClient, http.MethodPost, u, map[string]string{
		"Authorization": authToken,
	}, map[string]any{
		"bucketId":      bucketID,
		"startFileName": fileName,
		"prefix":        fileName,
		"maxFileCount":  100,
	}, &resp); err != nil {
		return nil, fmt.Errorf("could not list Backblaze B2 files: %w", err)
	}
	out := make([]b2FileVersion, 0, len(resp.Files))
	for _, f := range resp.Files {
		if f.FileName == fileName {
			out = append(out, f)
		}
	}
	return out, nil
}

func (c *B2Client) deleteFileVersion(apiURL, authToken, fileID, fileName string) error {
	u := strings.TrimRight(apiURL, "/") + "/b2api/v2/b2_delete_file_version"
	if err := doJSON(c.httpClient, http.MethodPost, u, map[string]string{
		"Authorization": authToken,
	}, map[string]string{
		"fileId":   fileID,
		"fileName": fileName,
	}, nil); err != nil {
		return fmt.Errorf("could not delete Backblaze B2 file: %w", err)
	}
	return nil
}

// SHA1HexOfFile computes the SHA-1 hex digest of r while also writing to w.
func SHA1HexOfFile(r io.Reader, w io.Writer) (string, int64, error) {
	h := sha1.New()
	n, err := io.Copy(io.MultiWriter(w, h), r)
	if err != nil {
		return "", n, err
	}
	return hex.EncodeToString(h.Sum(nil)), n, nil
}

func b2EncodeFileName(name string) string {
	// B2 wants percent-encoded UTF-8; keep slashes as path separators.
	parts := strings.Split(name, "/")
	for i, p := range parts {
		parts[i] = url.PathEscape(p)
	}
	return strings.Join(parts, "/")
}

func b2PathEscape(name string) string {
	cleaned := path.Clean("/" + strings.ReplaceAll(name, "\\", "/"))
	cleaned = strings.TrimPrefix(cleaned, "/")
	return b2EncodeFileName(cleaned)
}
