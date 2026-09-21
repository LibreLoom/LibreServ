package store

import (
	"errors"
	"fmt"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"io"
	"os"
	"path/filepath"
	"strings"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
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
	bucket, err := s.Provisioner.EnsureDeviceBucket(deviceID)
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

func (s *B2) Get(accountID, deviceID, relPath string) (io.ReadCloser, error) {
	key, err := s.objectKey(accountID, deviceID, relPath)
	if err != nil {
		return nil, err
	}
	bucket, err := s.Provisioner.EnsureDeviceBucket(deviceID)
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
	bucket, err := s.Provisioner.EnsureDeviceBucket(deviceID)
	if err != nil {
		return err
	}
	return s.Client.DeleteFile(bucket.KeyID, bucket.Key, bucket.BucketID, key)
}

func (s *B2) DeleteAccount(accountID string) error {
	if !opaqueIDOK(accountID) {
		return fmt.Errorf("that account is not allowed")
	}
	rows, err := s.DB.Query(`
SELECT device_id, relative_path
FROM backup_objects
WHERE account_id = ? AND COALESCE(storage_backend, 'local') = ?`,
		accountID, BackendB2)
	if err != nil {
		return err
	}
	defer rows.Close()

	var errs []error
	for rows.Next() {
		var deviceID, relPath string
		if err := rows.Scan(&deviceID, &relPath); err != nil {
			errs = append(errs, err)
			continue
		}
		if err := s.Delete(accountID, deviceID, relPath); err != nil {
			errs = append(errs, err)
		}
	}
	if err := rows.Err(); err != nil {
		errs = append(errs, err)
	}
	return errors.Join(errs...)
}
