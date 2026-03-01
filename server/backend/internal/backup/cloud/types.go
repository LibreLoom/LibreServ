package cloud

import (
	"context"
	"time"
)

type Provider string

const (
	ProviderBackblaze Provider = "backblaze"
	ProviderS3        Provider = "s3"
	ProviderManual    Provider = "manual"
)

type CloudConfig struct {
	ID        string    `json:"id"`
	Provider  Provider  `json:"provider"`
	Bucket    string    `json:"bucket"`
	Region    string    `json:"region,omitempty"`
	KeyID     string    `json:"key_id"`
	KeySecret string    `json:"key_secret,omitempty"`
	Endpoint  string    `json:"endpoint,omitempty"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (c *CloudConfig) IsConfigured() bool {
	if c.Provider == ProviderManual {
		return false
	}
	return c.Bucket != "" && c.KeyID != "" && c.KeySecret != ""
}

type RemoteBackup struct {
	ID         string    `json:"id"`
	BackupID   string    `json:"backup_id"`
	RemotePath string    `json:"remote_path"`
	Size       int64     `json:"size"`
	UploadedAt time.Time `json:"uploaded_at"`
}

type UploadProgress struct {
	BackupID   string `json:"backup_id"`
	BytesSent  int64  `json:"bytes_sent"`
	TotalBytes int64  `json:"total_bytes"`
	Percent    int    `json:"percent"`
	Status     string `json:"status"`
}

type CloudProvider interface {
	Upload(ctx context.Context, localPath, remotePath string) error
	Download(ctx context.Context, remotePath, localPath string) error
	Delete(ctx context.Context, remotePath string) error
	TestConnection(ctx context.Context) error
	ListBackups(ctx context.Context, prefix string) ([]RemoteBackup, error)
	GetProviderName() Provider
}

type ProviderConfig struct {
	Provider   Provider `json:"provider"`
	Name       string   `json:"name"`
	Icon       string   `json:"icon"`
	Requires   []string `json:"requires"`
	HelpURL    string   `json:"help_url"`
	SetupGuide string   `json:"setup_guide"`
}

var SupportedProviders = []ProviderConfig{
	{
		Provider: ProviderBackblaze,
		Name:     "Backblaze B2",
		Icon:     "backblaze",
		Requires: []string{"bucket", "key_id", "key_secret"},
		HelpURL:  "https://www.backblaze.com/b2/docs/",
		SetupGuide: `1. Sign up at backblaze.com
2. Create a B2 bucket in your dashboard
3. Create an application key with read/write access
4. Enter your Key ID and Key Secret below`,
	},
	{
		Provider: ProviderS3,
		Name:     "S3-Compatible Storage",
		Icon:     "s3",
		Requires: []string{"bucket", "key_id", "key_secret", "region"},
		HelpURL:  "https://docs.aws.amazon.com/s3/",
		SetupGuide: `1. Create an S3 bucket (or use any S3-compatible storage)
2. Create an IAM user with read/write permissions
3. Enter your Access Key ID and Secret Access Key below
4. For non-AWS storage, provide the custom endpoint`,
	},
	{
		Provider: ProviderManual,
		Name:     "Manual Setup Guide",
		Icon:     "manual",
		Requires: []string{},
		HelpURL:  "",
		SetupGuide: `For advanced users who prefer manual backup configuration:

1. Your backups are stored in: /var/lib/libreserv/backups/
2. Use any tool (rclone, rsync, etc.) to sync this directory
3. Example with rclone:
   rclone sync /var/lib/libreserv/backups/ remote:libreserv-backups/

See the documentation for recommended tools and configurations.`,
	},
}

type ConnectionTestResult struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
	Error   string `json:"error,omitempty"`
}
