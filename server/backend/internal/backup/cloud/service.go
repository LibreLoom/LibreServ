package cloud

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

type Service struct {
	db        *database.DB
	config    *CloudConfig
	provider  CloudProvider
	mu        sync.RWMutex
	jobs      map[string]*UploadJob
	secretKey []byte
}

type UploadJob struct {
	ID         string
	BackupID   string
	Status     string // "pending", "uploading", "completed", "failed"
	Progress   int
	Error      string
	StartedAt  time.Time
	FinishedAt time.Time
}

func NewService(db *database.DB, secretKey string) *Service {
	return &Service{
		db:        db,
		jobs:      make(map[string]*UploadJob),
		secretKey: []byte(secretKey),
	}
}

func (s *Service) LoadConfig(ctx context.Context) (*CloudConfig, error) {
	row := s.db.QueryRowContext(ctx, `
		SELECT id, provider, bucket, region, key_id, key_secret, endpoint, enabled, created_at, updated_at
		FROM cloud_backup_config
		WHERE id = 'default'
	`)

	var config CloudConfig
	var keySecretEnc string

	err := row.Scan(
		&config.ID, &config.Provider, &config.Bucket, &config.Region,
		&config.KeyID, &keySecretEnc, &config.Endpoint, &config.Enabled,
		&config.CreatedAt, &config.UpdatedAt,
	)

	if err != nil {
		if err.Error() == "sql: no rows in result set" {
			return nil, nil
		}
		return nil, fmt.Errorf("failed to load cloud config: %w", err)
	}

	if keySecretEnc != "" && len(s.secretKey) >= 32 {
		decrypted, err := s.decrypt(keySecretEnc)
		if err != nil {
			log.Printf("Failed to decrypt key secret: %v", err)
		} else {
			config.KeySecret = decrypted
		}
	}

	s.mu.Lock()
	s.config = &config
	s.mu.Unlock()

	return &config, nil
}

func (s *Service) SaveConfig(ctx context.Context, config *CloudConfig) error {
	keySecretEnc := ""
	if config.KeySecret != "" && len(s.secretKey) >= 32 {
		encrypted, err := s.encrypt(config.KeySecret)
		if err != nil {
			return fmt.Errorf("failed to encrypt key secret: %w", err)
		}
		keySecretEnc = encrypted
	}

	now := time.Now()
	config.UpdatedAt = now
	if config.CreatedAt.IsZero() {
		config.CreatedAt = now
	}

	_, err := s.db.ExecContext(ctx, `
		INSERT INTO cloud_backup_config (id, provider, bucket, region, key_id, key_secret, endpoint, enabled, created_at, updated_at)
		VALUES ('default', ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET
			provider = excluded.provider,
			bucket = excluded.bucket,
			region = excluded.region,
			key_id = excluded.key_id,
			key_secret = excluded.key_secret,
			endpoint = excluded.endpoint,
			enabled = excluded.enabled,
			updated_at = excluded.updated_at
	`, config.Provider, config.Bucket, config.Region, config.KeyID, keySecretEnc, config.Endpoint, config.Enabled, config.CreatedAt, config.UpdatedAt)

	if err != nil {
		return fmt.Errorf("failed to save cloud config: %w", err)
	}

	s.mu.Lock()
	s.config = config
	s.provider = nil
	s.mu.Unlock()

	return nil
}

func (s *Service) GetProvider(ctx context.Context) (CloudProvider, error) {
	s.mu.RLock()
	provider := s.provider
	s.mu.RUnlock()

	if provider != nil {
		return provider, nil
	}

	config, err := s.LoadConfig(ctx)
	if err != nil {
		return nil, err
	}
	if config == nil {
		return nil, fmt.Errorf("cloud backup not configured")
	}

	var newProvider CloudProvider

	switch config.Provider {
	case ProviderBackblaze:
		newProvider = NewBackblazeProvider(config.KeyID, config.KeySecret, config.Bucket)
	case ProviderS3:
		newProvider, err = NewS3Provider(config.KeyID, config.KeySecret, config.Bucket, config.Region, config.Endpoint)
		if err != nil {
			return nil, err
		}
	case ProviderManual:
		return nil, fmt.Errorf("manual provider does not support programmatic upload")
	default:
		return nil, fmt.Errorf("unknown provider: %s", config.Provider)
	}

	s.mu.Lock()
	s.provider = newProvider
	s.mu.Unlock()

	return newProvider, nil
}

func (s *Service) TestConnection(ctx context.Context) (*ConnectionTestResult, error) {
	provider, err := s.GetProvider(ctx)
	if err != nil {
		return &ConnectionTestResult{
			Success: false,
			Message: "Provider not configured",
			Error:   err.Error(),
		}, nil
	}

	if err := provider.TestConnection(ctx); err != nil {
		return &ConnectionTestResult{
			Success: false,
			Message: "Connection test failed",
			Error:   err.Error(),
		}, nil
	}

	return &ConnectionTestResult{
		Success: true,
		Message: fmt.Sprintf("Successfully connected to %s bucket %s", provider.GetProviderName(), s.config.Bucket),
	}, nil
}

func (s *Service) UploadBackup(ctx context.Context, backupID, localPath string) error {
	provider, err := s.GetProvider(ctx)
	if err != nil {
		return err
	}

	s.mu.RLock()
	config := s.config
	s.mu.RUnlock()

	if config == nil || !config.Enabled {
		return fmt.Errorf("cloud backup not enabled")
	}

	remotePath := s.buildRemotePath(backupID, localPath)

	job := &UploadJob{
		ID:        backupID,
		BackupID:  backupID,
		Status:    "uploading",
		StartedAt: time.Now(),
	}
	s.mu.Lock()
	s.jobs[backupID] = job
	s.mu.Unlock()

	err = provider.Upload(ctx, localPath, remotePath)

	s.mu.Lock()
	defer s.mu.Unlock()
	job.FinishedAt = time.Now()

	if err != nil {
		job.Status = "failed"
		job.Error = err.Error()
		return err
	}

	job.Status = "completed"
	job.Progress = 100

	s.saveRemoteBackupRecord(ctx, backupID, remotePath, localPath)

	return nil
}

func (s *Service) UploadBackupAsync(backupID, localPath string) error {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()

		if err := s.UploadBackup(ctx, backupID, localPath); err != nil {
			log.Printf("Cloud backup upload failed for %s: %v", backupID, err)
		}
	}()

	job := &UploadJob{
		ID:        backupID,
		BackupID:  backupID,
		Status:    "pending",
		StartedAt: time.Now(),
	}
	s.mu.Lock()
	s.jobs[backupID] = job
	s.mu.Unlock()

	return nil
}

func (s *Service) GetUploadStatus(backupID string) *UploadJob {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.jobs[backupID]
}

func (s *Service) DownloadBackup(ctx context.Context, backupID, localPath string) error {
	provider, err := s.GetProvider(ctx)
	if err != nil {
		return err
	}

	remotePath := s.buildRemotePath(backupID, localPath)

	return provider.Download(ctx, remotePath, localPath)
}

func (s *Service) ListRemoteBackups(ctx context.Context) ([]RemoteBackup, error) {
	provider, err := s.GetProvider(ctx)
	if err != nil {
		return nil, err
	}

	return provider.ListBackups(ctx, "libreserv/")
}

func (s *Service) DeleteRemoteBackup(ctx context.Context, backupID string) error {
	provider, err := s.GetProvider(ctx)
	if err != nil {
		return err
	}

	var remotePath string
	err = s.db.QueryRowContext(ctx, `
		SELECT remote_path FROM cloud_backups WHERE backup_id = ?
	`, backupID).Scan(&remotePath)

	if err != nil {
		remotePath = fmt.Sprintf("libreserv/backups/%s.tar.gz", backupID)
	}

	if err := provider.Delete(ctx, remotePath); err != nil {
		return err
	}

	_, err = s.db.ExecContext(ctx, `DELETE FROM cloud_backups WHERE backup_id = ?`, backupID)
	return err
}

func (s *Service) GetRemoteBackupStatus(ctx context.Context, backupID string) (*RemoteBackup, error) {
	var rb RemoteBackup
	err := s.db.QueryRowContext(ctx, `
		SELECT id, backup_id, remote_path, size, uploaded_at
		FROM cloud_backups WHERE backup_id = ?
	`, backupID).Scan(&rb.ID, &rb.BackupID, &rb.RemotePath, &rb.Size, &rb.UploadedAt)

	if err != nil {
		return nil, err
	}
	return &rb, nil
}

func (s *Service) GetSupportedProviders() []ProviderConfig {
	return SupportedProviders
}

func (s *Service) IsConfigured() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.config != nil && s.config.IsConfigured()
}

func (s *Service) IsEnabled() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.config != nil && s.config.Enabled
}

func (s *Service) buildRemotePath(backupID, localPath string) string {
	ext := filepath.Ext(localPath)
	return fmt.Sprintf("libreserv/backups/%s%s", backupID, ext)
}

func (s *Service) saveRemoteBackupRecord(ctx context.Context, backupID, remotePath, localPath string) {
	stat, err := os.Stat(localPath)
	if err != nil {
		log.Printf("Failed to stat backup file: %v", err)
		return
	}

	_, err = s.db.ExecContext(ctx, `
		INSERT INTO cloud_backups (id, backup_id, remote_path, size, uploaded_at)
		VALUES (?, ?, ?, ?, ?)
		ON CONFLICT(backup_id) DO UPDATE SET
			remote_path = excluded.remote_path,
			size = excluded.size,
			uploaded_at = excluded.uploaded_at
	`, fmt.Sprintf("cloud-%s", backupID), backupID, remotePath, stat.Size(), time.Now())

	if err != nil {
		log.Printf("Failed to save cloud backup record: %v", err)
	}
}

func (s *Service) encrypt(plaintext string) (string, error) {
	if len(s.secretKey) < 32 {
		return "", fmt.Errorf("secret key too short")
	}

	block, err := aes.NewCipher(s.secretKey[:32])
	if err != nil {
		return "", err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	nonce := make([]byte, gcm.NonceSize())
	if _, err = io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}

	ciphertext := gcm.Seal(nonce, nonce, []byte(plaintext), nil)
	return base64.StdEncoding.EncodeToString(ciphertext), nil
}

func (s *Service) decrypt(ciphertext string) (string, error) {
	data, err := base64.StdEncoding.DecodeString(ciphertext)
	if err != nil {
		return "", err
	}

	block, err := aes.NewCipher(s.secretKey[:32])
	if err != nil {
		return "", err
	}

	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}

	nonceSize := gcm.NonceSize()
	if len(data) < nonceSize {
		return "", fmt.Errorf("ciphertext too short")
	}

	nonce, cipherData := data[:nonceSize], data[nonceSize:]
	plaintext, err := gcm.Open(nil, nonce, cipherData, nil)
	if err != nil {
		return "", err
	}

	return string(plaintext), nil
}

func (s *Service) GetBackupCloudStatus(ctx context.Context, backupID string) (map[string]interface{}, error) {
	var hasCloud bool
	err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS(SELECT 1 FROM cloud_backups WHERE backup_id = ?)
	`, backupID).Scan(&hasCloud)

	if err != nil {
		return nil, err
	}

	status := map[string]interface{}{
		"has_cloud_copy": hasCloud,
	}

	if hasCloud {
		var uploadedAt time.Time
		err = s.db.QueryRowContext(ctx, `
			SELECT uploaded_at FROM cloud_backups WHERE backup_id = ?
		`, backupID).Scan(&uploadedAt)

		if err == nil {
			status["cloud_uploaded_at"] = uploadedAt
		}
	}

	return status, nil
}

type BackupMetadata struct {
	BackupID    string                 `json:"backup_id"`
	AppID       string                 `json:"app_id"`
	Type        string                 `json:"type"`
	CreatedAt   time.Time              `json:"created_at"`
	Size        int64                  `json:"size"`
	Checksum    string                 `json:"checksum"`
	CloudStatus map[string]interface{} `json:"cloud_status"`
}

func (s *Service) GetBackupsWithCloudStatus(ctx context.Context) ([]BackupMetadata, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT b.id, b.app_id, b.type, b.created_at, b.size, b.checksum,
			EXISTS(SELECT 1 FROM cloud_backups cb WHERE cb.backup_id = b.id) as has_cloud
		FROM backups b
		ORDER BY b.created_at DESC
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var backups []BackupMetadata
	for rows.Next() {
		var b BackupMetadata
		var hasCloud bool
		if err := rows.Scan(&b.BackupID, &b.AppID, &b.Type, &b.CreatedAt, &b.Size, &b.Checksum, &hasCloud); err != nil {
			continue
		}
		b.CloudStatus = map[string]interface{}{
			"has_cloud_copy": hasCloud,
		}
		backups = append(backups, b)
	}

	return backups, nil
}

func ToJSON(v interface{}) string {
	data, _ := json.Marshal(v)
	return string(data)
}
