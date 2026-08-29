package providers

import (
	"database/sql"
	"fmt"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

// BucketProvisioner creates and persists one B2 bucket per Luna device.
type BucketProvisioner struct {
	DB        *sql.DB
	Providers *Service
	B2        *B2Client
}

// DeviceBucket is the persisted mapping for a device's private B2 bucket.
type DeviceBucket struct {
	DeviceID   string
	BucketName string
	BucketID   string
	Endpoint   string
	KeyID      string
	Key        string // plaintext after OpenString
}

// ErrBackupNotConfigured means Admin → Connections has no enabled B2 provider.
var ErrBackupNotConfigured = fmt.Errorf("off-site storage is not configured. Add an enabled Backblaze B2 connection in Admin → Connections, or contact support")

// EnsureDeviceBucket returns existing credentials or provisions a new bucket (idempotent).
func (p *BucketProvisioner) EnsureDeviceBucket(deviceID string) (*DeviceBucket, error) {
	if deviceID == "" {
		return nil, fmt.Errorf("missing device")
	}
	if existing, err := p.load(deviceID); err != nil {
		return nil, err
	} else if existing != nil {
		return existing, nil
	}

	prov, err := p.Providers.FindEnabled("backup")
	if err != nil {
		return nil, fmt.Errorf("could not look up backup connection: %w", err)
	}
	if prov == nil || strings.TrimSpace(prov.Credential("account_id", "")) == "" ||
		strings.TrimSpace(prov.Credential("application_key", "")) == "" {
		return nil, ErrBackupNotConfigured
	}

	prefix := prov.Setting("bucket_prefix", "luna-backup")
	prefix = sanitizeBucketPart(prefix)
	if prefix == "" {
		prefix = "luna-backup"
	}
	bucketName := prefix + "-" + sanitizeBucketPart(deviceID)
	if len(bucketName) > 50 {
		bucketName = bucketName[:50]
		bucketName = strings.Trim(bucketName, "-")
	}

	b2 := p.B2
	if b2 == nil {
		b2 = NewB2Client(nil)
	}
	creds, err := b2.ProvisionBucket(
		prov.Credential("account_id", ""),
		prov.Credential("application_key", ""),
		bucketName,
	)
	if err != nil {
		return nil, fmt.Errorf("could not create a cloud backup bucket for this Luna: %w", err)
	}

	sealed, err := security.SealString(creds.Key)
	if err != nil {
		return nil, fmt.Errorf("could not protect backup credentials: %w", err)
	}
	now := time.Now().Unix()
	_, err = p.DB.Exec(`
INSERT INTO device_backup_buckets (device_id, bucket_name, bucket_id, endpoint, key_id, application_key_sealed, provisioned_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(device_id) DO NOTHING`,
		deviceID, creds.BucketName, creds.BucketID, creds.Endpoint, creds.KeyID, sealed, now)
	if err != nil {
		return nil, fmt.Errorf("could not save backup bucket mapping: %w", err)
	}

	// Another instance may have won the race; always re-read.
	existing, err := p.load(deviceID)
	if err != nil {
		return nil, err
	}
	if existing == nil {
		return nil, fmt.Errorf("could not load backup bucket after provisioning")
	}
	return existing, nil
}

func (p *BucketProvisioner) load(deviceID string) (*DeviceBucket, error) {
	var b DeviceBucket
	var sealed string
	err := p.DB.QueryRow(`
SELECT device_id, bucket_name, bucket_id, endpoint, key_id, application_key_sealed
FROM device_backup_buckets WHERE device_id = ?`, deviceID).
		Scan(&b.DeviceID, &b.BucketName, &b.BucketID, &b.Endpoint, &b.KeyID, &sealed)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	key, err := security.OpenString(sealed)
	if err != nil {
		return nil, fmt.Errorf("could not unlock backup credentials: %w", err)
	}
	b.Key = key
	return &b, nil
}

func sanitizeBucketPart(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			b.WriteRune(r)
		case r == '-' || r == '_':
			b.WriteByte('-')
		}
	}
	out := b.String()
	for strings.Contains(out, "--") {
		out = strings.ReplaceAll(out, "--", "-")
	}
	return strings.Trim(out, "-")
}
