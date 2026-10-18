package store

import (
	"database/sql"
	"errors"
	"fmt"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"io"
	"os"
	"path/filepath"
	"strings"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

// B2 stores backup objects in one Backblaze B2 bucket per Luna device.
type B2 struct {
	DB          *database.DB
	Provisioner *providers.BucketProvisioner
	Client      *providers.B2Client
	TmpDir      string
}

// NewB2 creates a B2-backed object store. tmpDir holds brief staging files during upload.
func NewB2(db *database.DB, tmpDir string) (*B2, error) {
	if tmpDir == "" {
		tmpDir = os.TempDir()
	}
	if err := os.MkdirAll(tmpDir, 0o700); err != nil {
		return nil, err
	}
	client := providers.NewB2Client(nil)
	return &B2{
		DB: db,
		Provisioner: &providers.BucketProvisioner{
			DB:        db,
			Providers: providers.NewService(db),
			B2:        client,
		},
		Client: client,
		TmpDir: tmpDir,
	}, nil
}

func (s *B2) objectKey(accountID, deviceID, relPath string) (string, error) {
	if !opaqueIDOK(accountID) || !opaqueIDOK(deviceID) {
		return "", fmt.Errorf("that file path is not allowed")
	}
	if strings.ContainsRune(relPath, 0) || strings.Contains(relPath, "..") || strings.ContainsAny(relPath, `\\`) {
		return "", fmt.Errorf("that file path is not allowed")
	}
	clean := filepath.ToSlash(filepath.Clean("/" + strings.ReplaceAll(relPath, "\\", "/")))
	clean = strings.TrimPrefix(clean, "/")
	if clean == "" || strings.Contains(clean, "..") {
		return "", fmt.Errorf("that file path is not allowed")
	}
	// Keep account namespace inside the device bucket so paths stay unique if a
	// device is ever reassigned (defense in depth; one device = one bucket).
	return accountID + "/" + clean, nil
}

func (s *B2) Put(accountID, deviceID, relPath string, r io.Reader) (int64, string, error) {
	key, err := s.objectKey(accountID, deviceID, relPath)
	if err != nil {
		return 0, BackendB2, err
	}
	bucket, err := s.Provisioner.EnsureDeviceBucket(providers.BucketKey(accountID, deviceID))
	if err != nil {
		return 0, BackendB2, err
	}

	tmp, err := os.CreateTemp(s.TmpDir, "luna-b2-*")
	if err != nil {
		return 0, BackendB2, err
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()
	_ = os.Chmod(tmpName, 0o600)

	sha1Hex, n, err := providers.SHA1HexOfFile(r, tmp)
	if err != nil {
		return n, BackendB2, err
	}
	if _, err := tmp.Seek(0, io.SeekStart); err != nil {
		return n, BackendB2, err
	}

	if err := s.Client.UploadFile(bucket.KeyID, bucket.Key, bucket.BucketID, key, tmp, n, sha1Hex); err != nil {
		return n, BackendB2, err
	}
	return n, BackendB2, nil
}

// existingBucket returns a Luna's bucket on an account if one was already provisioned. It never
// creates a bucket, so reads and deletes cannot provision new Backblaze storage.
// A missing bucket reports os.ErrNotExist.
func (s *B2) existingBucket(accountID, deviceID string) (*providers.DeviceBucket, error) {
	var b providers.DeviceBucket
	var sealed string
	err := s.DB.QueryRow(`
SELECT device_id, bucket_name, bucket_id, endpoint, key_id, application_key_sealed
FROM device_backup_buckets WHERE device_id = ?`, providers.BucketKey(accountID, deviceID)).
		Scan(&b.DeviceID, &b.BucketName, &b.BucketID, &b.Endpoint, &b.KeyID, &sealed)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fmt.Errorf("no backup bucket for this Luna: %w", os.ErrNotExist)
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

func (s *B2) Get(accountID, deviceID, relPath string) (io.ReadCloser, error) {
	key, err := s.objectKey(accountID, deviceID, relPath)
	if err != nil {
		return nil, err
	}
	bucket, err := s.existingBucket(accountID, deviceID)
	if err != nil {
		return nil, err
	}
	return s.Client.DownloadFile(bucket.KeyID, bucket.Key, bucket.BucketName, key)
}

func (s *B2) Delete(accountID, deviceID, relPath string) error {
	key, err := s.objectKey(accountID, deviceID, relPath)
	if err != nil {
		return err
	}
	bucket, err := s.existingBucket(accountID, deviceID)
	if err != nil {
		return err
	}
	return s.Client.DeleteFile(bucket.KeyID, bucket.Key, bucket.BucketID, key)
}

func (s *B2) DeleteAccount(accountID string) error {
	if !opaqueIDOK(accountID) {
		return fmt.Errorf("that account is not allowed")
	}
	var errs []error

	packs, err := s.DB.Query(`
SELECT luna_id, id
FROM storage_packs
WHERE account_id = ? AND COALESCE(storage_backend, 'local') = ?`,
		accountID, BackendB2)
	if err != nil {
		return err
	}
	defer packs.Close()
	for packs.Next() {
		var lunaID, id string
		if err := packs.Scan(&lunaID, &id); err != nil {
			errs = append(errs, err)
			continue
		}
		if err := s.Delete(accountID, StorageSlot(lunaID), StoragePackPath(id)); err != nil {
			errs = append(errs, err)
		}
	}
	if err := packs.Err(); err != nil {
		errs = append(errs, err)
	}

	records, err := s.DB.Query(`
SELECT luna_id, kind, name
FROM storage_records
WHERE account_id = ? AND COALESCE(storage_backend, 'local') = ?`,
		accountID, BackendB2)
	if err != nil {
		return errors.Join(append(errs, err)...)
	}
	defer records.Close()
	for records.Next() {
		var lunaID, kind, name string
		if err := records.Scan(&lunaID, &kind, &name); err != nil {
			errs = append(errs, err)
			continue
		}
		if err := s.Delete(accountID, StorageSlot(lunaID), StorageRecordPath(kind, name)); err != nil {
			errs = append(errs, err)
		}
	}
	if err := records.Err(); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}

// ReleaseBuckets deletes the B2 buckets and keys of a purged Luna (lunaID "" means every Luna on
// the account). Buckets that still hold files are kept.
func (s *B2) ReleaseBuckets(accountID, lunaID string) error {
	slot := ""
	if lunaID != "" {
		slot = StorageSlot(lunaID)
	}
	return s.Provisioner.ReleaseBuckets(accountID, slot)
}
