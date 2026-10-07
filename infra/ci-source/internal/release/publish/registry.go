package publish

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"time"
)

// ErrConflict means a file already exists in the registry with different bytes.
var ErrConflict = errors.New("file already exists with different contents")

// Registry is a client for the Forgejo generic package registry:
//
//	<BaseURL>/api/packages/<Owner>/generic/<unit>/<version>/<file>
type Registry struct {
	BaseURL string // e.g. https://gt.plainskill.net
	Owner   string
	Token   TokenSource
	HTTP    *http.Client
	// Retries is how many extra attempts a failed upload gets (network errors
	// and 5xx), Backoff the pause between them.
	Retries int
	Backoff time.Duration
}

func (r *Registry) client() *http.Client {
	if r.HTTP != nil {
		return r.HTTP
	}
	return http.DefaultClient
}

// FileURL is the public download URL of one file.
func (r *Registry) FileURL(unit, version, file string) string {
	return fmt.Sprintf("%s/api/packages/%s/generic/%s/%s/%s", trimSlash(r.BaseURL),
		url.PathEscape(r.Owner), url.PathEscape(unit), url.PathEscape(version), url.PathEscape(file))
}

func trimSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}

func (r *Registry) do(ctx context.Context, method, u string, body io.Reader, size int64) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, u, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.ContentLength = size
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	if r.Token != nil {
		tok, err := r.Token.Token()
		if err != nil {
			return nil, fmt.Errorf("forgejo token: %w", err)
		}
		if tok != "" {
			req.Header.Set("Authorization", "token "+tok)
		}
	}
	return r.client().Do(req)
}

func snippet(resp *http.Response) string {
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 200))
	return string(bytes.TrimSpace(b))
}

// UploadResult says what Upload did.
type UploadResult struct {
	// Existed is true when the registry already held exactly these bytes.
	Existed bool
}

// Upload PUTs the file at path as <unit>/<version>/<file>. If the registry
// already has the file, identical bytes are fine (idempotent) and different
// bytes are ErrConflict.
func (r *Registry) Upload(ctx context.Context, unit, version, file, path string) (UploadResult, error) {
	local, err := HashFile(path)
	if err != nil {
		return UploadResult{}, err
	}
	u := r.FileURL(unit, version, file)
	var lastErr error
	for attempt := 0; attempt <= r.Retries; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return UploadResult{}, ctx.Err()
			case <-time.After(r.Backoff):
			}
		}
		f, err := os.Open(path)
		if err != nil {
			return UploadResult{}, err
		}
		resp, err := r.do(ctx, http.MethodPut, u, f, local.Size)
		f.Close()
		if err != nil {
			lastErr = fmt.Errorf("upload %s: %w", file, err)
			continue
		}
		code := resp.StatusCode
		msg := snippet(resp)
		resp.Body.Close()
		switch {
		case code == 200 || code == 201 || code == 204:
			return UploadResult{}, nil
		case code == http.StatusConflict || code == http.StatusBadRequest:
			// Probably "already exists"; the registry holds the truth.
			if err := r.Check(ctx, unit, version, file, local); err == nil {
				return UploadResult{Existed: true}, nil
			} else if errors.Is(err, ErrConflict) {
				return UploadResult{}, fmt.Errorf("upload %s: %w", file, err)
			}
			return UploadResult{}, fmt.Errorf("upload %s: HTTP %d %s", file, code, msg)
		case code >= 500:
			lastErr = fmt.Errorf("upload %s: HTTP %d %s", file, code, msg)
		default:
			return UploadResult{}, fmt.Errorf("upload %s: HTTP %d %s", file, code, msg)
		}
	}
	return UploadResult{}, lastErr
}

// Fetch downloads the file and returns its size and SHA-256 (the bytes are
// hashed as they stream, never held in memory).
func (r *Registry) Fetch(ctx context.Context, unit, version, file string) (FileInfo, error) {
	resp, err := r.do(ctx, http.MethodGet, r.FileURL(unit, version, file), nil, 0)
	if err != nil {
		return FileInfo{}, fmt.Errorf("download %s: %w", file, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return FileInfo{}, fmt.Errorf("download %s: HTTP %d %s", file, resp.StatusCode, snippet(resp))
	}
	h := sha256.New()
	n, err := io.Copy(h, resp.Body)
	if err != nil {
		return FileInfo{}, fmt.Errorf("download %s: %w", file, err)
	}
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		if want, err := strconv.ParseInt(cl, 10, 64); err == nil && want != n {
			return FileInfo{}, fmt.Errorf("download %s: got %d of %d bytes", file, n, want)
		}
	}
	return FileInfo{Size: n, SHA256: hex.EncodeToString(h.Sum(nil))}, nil
}

// Check re-downloads the file and compares it with want. A mismatch is
// ErrConflict.
func (r *Registry) Check(ctx context.Context, unit, version, file string, want FileInfo) error {
	got, err := r.Fetch(ctx, unit, version, file)
	if err != nil {
		return err
	}
	if got != want {
		return fmt.Errorf("%s/%s/%s: registry has %d bytes sha256 %s, expected %d bytes sha256 %s: %w",
			unit, version, file, got.Size, got.SHA256, want.Size, want.SHA256, ErrConflict)
	}
	return nil
}

// Delete removes one file (for probes and cleanup). A missing file is fine.
func (r *Registry) Delete(ctx context.Context, unit, version, file string) error {
	resp, err := r.do(ctx, http.MethodDelete, r.FileURL(unit, version, file), nil, 0)
	if err != nil {
		return fmt.Errorf("delete %s: %w", file, err)
	}
	defer resp.Body.Close()
	if c := resp.StatusCode; c == 200 || c == 204 || c == 404 {
		return nil
	}
	return fmt.Errorf("delete %s: HTTP %d %s", file, resp.StatusCode, snippet(resp))
}
