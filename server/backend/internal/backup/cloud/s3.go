package cloud

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

type S3Provider struct {
	client   *minio.Client
	bucket   string
	endpoint string
	region   string
}

func NewS3Provider(keyID, keySecret, bucket, region, endpoint string) (*S3Provider, error) {
	if endpoint == "" {
		if region == "" {
			region = "us-east-1"
		}
		endpoint = "s3.amazonaws.com"
	}

	var useSSL = true
	if strings.HasPrefix(endpoint, "http://") {
		useSSL = false
		endpoint = strings.TrimPrefix(endpoint, "http://")
	}
	endpoint = strings.TrimPrefix(endpoint, "https://")

	client, err := minio.New(endpoint, &minio.Options{
		Creds:  credentials.NewStaticV4(keyID, keySecret, ""),
		Secure: useSSL,
		Region: region,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to create S3 client: %w", err)
	}

	return &S3Provider{
		client:   client,
		bucket:   bucket,
		endpoint: endpoint,
		region:   region,
	}, nil
}

func (p *S3Provider) GetProviderName() Provider {
	return ProviderS3
}

func (p *S3Provider) TestConnection(ctx context.Context) error {
	exists, err := p.client.BucketExists(ctx, p.bucket)
	if err != nil {
		return fmt.Errorf("failed to check bucket existence: %w", err)
	}
	if !exists {
		return fmt.Errorf("bucket %s does not exist", p.bucket)
	}
	return nil
}

func (p *S3Provider) Upload(ctx context.Context, localPath, remotePath string) error {
	file, err := os.Stat(localPath)
	if err != nil {
		return fmt.Errorf("failed to stat local file: %w", err)
	}

	uploadInfo, err := p.client.FPutObject(ctx, p.bucket, remotePath, localPath, minio.PutObjectOptions{
		ContentType: "application/octet-stream",
	})
	if err != nil {
		return fmt.Errorf("upload failed: %w", err)
	}

	if uploadInfo.Size != file.Size() {
		return fmt.Errorf("upload size mismatch: expected %d, got %d", file.Size(), uploadInfo.Size)
	}

	return nil
}

func (p *S3Provider) Download(ctx context.Context, remotePath, localPath string) error {
	if err := os.MkdirAll(filepath.Dir(localPath), 0755); err != nil {
		return fmt.Errorf("failed to create local directory: %w", err)
	}

	err := p.client.FGetObject(ctx, p.bucket, remotePath, localPath, minio.GetObjectOptions{})
	if err != nil {
		return fmt.Errorf("download failed: %w", err)
	}

	return nil
}

func (p *S3Provider) Delete(ctx context.Context, remotePath string) error {
	err := p.client.RemoveObject(ctx, p.bucket, remotePath, minio.RemoveObjectOptions{})
	if err != nil {
		return fmt.Errorf("delete failed: %w", err)
	}
	return nil
}

func (p *S3Provider) ListBackups(ctx context.Context, prefix string) ([]RemoteBackup, error) {
	var backups []RemoteBackup

	objects := p.client.ListObjects(ctx, p.bucket, minio.ListObjectsOptions{
		Prefix:    prefix,
		Recursive: true,
	})

	for obj := range objects {
		if obj.Err != nil {
			return nil, fmt.Errorf("error listing objects: %w", obj.Err)
		}

		backupID := strings.TrimSuffix(filepath.Base(obj.Key), filepath.Ext(obj.Key))
		backupID = strings.TrimPrefix(backupID, "libreserv-")

		backups = append(backups, RemoteBackup{
			ID:         obj.Key,
			BackupID:   backupID,
			RemotePath: obj.Key,
			Size:       obj.Size,
			UploadedAt: obj.LastModified,
		})
	}

	return backups, nil
}

type HTTPProgressWriter struct {
	Total      int64
	Written    int64
	OnProgress func(percent int)
}

func (w *HTTPProgressWriter) Write(p []byte) (int, error) {
	n := len(p)
	w.Written += int64(n)
	if w.Total > 0 && w.OnProgress != nil {
		percent := int(float64(w.Written) / float64(w.Total) * 100)
		if percent > 100 {
			percent = 100
		}
		w.OnProgress(percent)
	}
	return n, nil
}

func (p *S3Provider) UploadWithProgress(ctx context.Context, localPath, remotePath string, onProgress func(percent int)) error {
	file, err := os.Open(localPath)
	if err != nil {
		return fmt.Errorf("failed to open file: %w", err)
	}
	defer file.Close()

	stat, err := file.Stat()
	if err != nil {
		return fmt.Errorf("failed to stat file: %w", err)
	}

	pw := &HTTPProgressWriter{Total: stat.Size(), OnProgress: onProgress}

	_, err = p.client.PutObject(ctx, p.bucket, remotePath, io.TeeReader(file, pw), stat.Size(), minio.PutObjectOptions{
		ContentType: "application/octet-stream",
	})
	return err
}

func NewHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 30 * time.Minute,
	}
}

func (p *S3Provider) GetPresignedURL(ctx context.Context, remotePath string, expiry time.Duration) (string, error) {
	reqParams := make(url.Values)
	presignedURL, err := p.client.PresignedGetObject(ctx, p.bucket, remotePath, expiry, reqParams)
	if err != nil {
		return "", fmt.Errorf("failed to generate presigned URL: %w", err)
	}
	return presignedURL.String(), nil
}
