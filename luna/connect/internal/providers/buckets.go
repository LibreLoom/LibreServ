package providers

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"fmt"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"log/slog"
	"strings"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

// BucketProvisioner creates and persists one B2 bucket per Luna device.
type BucketProvisioner struct {
	DB        *database.DB
	Providers *Service
	B2        *B2Client

	// Now returns the current time. Nil means time.Now; tests set it to drive the retry backoff.
	Now func() time.Time

	// keepLast tracks, per device, whether the keep-last-version rule is known to be set and
	// when it may be tried again after a failure. Guarded by keepLastMu.
	keepLastMu sync.Mutex
	keepLast   map[string]*keepLastState
}

// keepLastState is the in-memory record for one device's keep-last-version rule.
type keepLastState struct {
	done     bool      // the rule is known to be set; B2 is not asked again this process
	inFlight bool      // a call to B2 is running now; other requests skip it rather than queue
	failures int       // failed attempts in a row
	retryAt  time.Time // no new attempt before this time
}

const (
	// keepLastRetryFirst is the wait after the first failure. Each further failure doubles it,
	// up to keepLastRetryMax, so a key without bucket-write rights costs a few B2 calls a day,
	// not one per request.
	keepLastRetryFirst = 5 * time.Minute
	keepLastRetryMax   = 6 * time.Hour
)

// keepLastBackoff is the wait after the given number of failures in a row (1 = first failure).
func keepLastBackoff(failures int) time.Duration {
	wait := keepLastRetryFirst
	for i := 1; i < failures; i++ {
		wait *= 2
		if wait >= keepLastRetryMax {
			return keepLastRetryMax
		}
	}
	return wait
}

func (p *BucketProvisioner) now() time.Time {
	if p.Now != nil {
		return p.Now()
	}
	return time.Now()
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

// BucketKey names the bucket of one Luna on one account. Two accounts never share a key, so they
// never share a bucket, whatever Luna ID a client sends.
func BucketKey(accountID, slot string) string {
	return accountID + ":" + slot
}

// bucketName is the B2 bucket name for a bucket key: a short prefix and a hash of the whole key.
// The hash keeps names unique and the same length however long the Luna ID is, so a long ID can
// never be cut down into another Luna's name.
func bucketName(prefix, key string) string {
	if len(prefix) > 12 {
		prefix = strings.Trim(prefix[:12], "-")
	}
	sum := sha256.Sum256([]byte(key))
	return prefix + "-" + hex.EncodeToString(sum[:])[:36]
}

// EnsureDeviceBucket returns existing credentials or provisions a new bucket (idempotent).
// deviceID is a BucketKey.
func (p *BucketProvisioner) EnsureDeviceBucket(deviceID string) (*DeviceBucket, error) {
	if deviceID == "" {
		return nil, fmt.Errorf("missing device")
	}
	if existing, err := p.load(deviceID); err != nil {
		return nil, err
	} else if existing != nil {
		p.ensureKeepLast(existing)
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
	name := bucketName(prefix, deviceID)

	b2 := p.B2
	if b2 == nil {
		b2 = NewB2Client(nil)
	}
	masterID, masterKey := prov.Credential("account_id", ""), prov.Credential("application_key", "")
	creds, err := b2.ProvisionBucket(masterID, masterKey, name)
	if err != nil {
		return nil, fmt.Errorf("could not create a cloud backup bucket for this Luna: %w", err)
	}
	// A key that is not saved is a working key to the bucket that nobody can ever use or
	// revoke. Revoke it here so a failed save or a lost race leaves nothing behind.
	revokeNew := func() {
		if err := b2.DeleteKey(masterID, masterKey, creds.KeyID); err != nil {
			slog.Warn("backup bucket: could not revoke an unused key", "error", err)
		}
	}

	sealed, err := security.SealString(creds.Key)
	if err != nil {
		revokeNew()
		return nil, fmt.Errorf("could not protect backup credentials: %w", err)
	}
	now := time.Now().Unix()
	_, err = p.DB.Exec(`
INSERT INTO device_backup_buckets (device_id, bucket_name, bucket_id, endpoint, key_id, application_key_sealed, provisioned_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(device_id) DO NOTHING`,
		deviceID, creds.BucketName, creds.BucketID, creds.Endpoint, creds.KeyID, sealed, now)
	if err != nil {
		revokeNew()
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
	if existing.KeyID != creds.KeyID {
		revokeNew()
	}
	return existing, nil
}

// ensureKeepLast gives a bucket provisioned before the keep-last-version rule existed that rule,
// so an old phrase's replaced key copies are deleted a day after they are hidden. Best effort and
// logged: a failure never blocks the backup. After a failure the bucket is not tried again until
// an exponential backoff has passed, and while one call is talking to B2 the others skip it.
func (p *BucketProvisioner) ensureKeepLast(b *DeviceBucket) {
	if !p.beginKeepLast(b.DeviceID) {
		return
	}
	attempted, err := p.setKeepLast(b)
	if !attempted {
		p.finishKeepLast(b.DeviceID, nil, false)
		return
	}
	p.finishKeepLast(b.DeviceID, err, true)
	if err != nil {
		slog.Warn("backup bucket: could not set keep-last-version on an existing bucket", "bucket", b.BucketName, "error", err)
	}
}

// beginKeepLast reports whether this call should ask B2 now, and marks the attempt as running.
func (p *BucketProvisioner) beginKeepLast(deviceID string) bool {
	p.keepLastMu.Lock()
	defer p.keepLastMu.Unlock()
	if p.keepLast == nil {
		p.keepLast = map[string]*keepLastState{}
	}
	st := p.keepLast[deviceID]
	if st == nil {
		st = &keepLastState{}
		p.keepLast[deviceID] = st
	}
	if st.done || st.inFlight || p.now().Before(st.retryAt) {
		return false
	}
	st.inFlight = true
	return true
}

// finishKeepLast records the outcome of an attempt started by beginKeepLast. attempted is false
// when nothing was asked of B2 (no backup connection), so nothing is remembered and it is tried
// again on the next request.
func (p *BucketProvisioner) finishKeepLast(deviceID string, err error, attempted bool) {
	p.keepLastMu.Lock()
	defer p.keepLastMu.Unlock()
	st := p.keepLast[deviceID]
	st.inFlight = false
	if !attempted {
		return
	}
	if err == nil {
		st.done = true
		st.failures = 0
		st.retryAt = time.Time{}
		return
	}
	st.failures++
	st.retryAt = p.now().Add(keepLastBackoff(st.failures))
}

// setKeepLast asks B2 to apply the keep-last-version rule to the bucket. attempted is false when
// no usable backup connection exists, so B2 was never asked.
func (p *BucketProvisioner) setKeepLast(b *DeviceBucket) (attempted bool, err error) {
	prov, lookupErr := p.Providers.FindEnabled("backup")
	if lookupErr != nil || prov == nil {
		return false, nil
	}
	masterID, masterKey := prov.Credential("account_id", ""), prov.Credential("application_key", "")
	if strings.TrimSpace(masterID) == "" || strings.TrimSpace(masterKey) == "" {
		return false, nil
	}
	b2 := p.B2
	if b2 == nil {
		b2 = NewB2Client(nil)
	}
	return true, b2.EnsureKeepLastVersionByName(masterID, masterKey, b.BucketName)
}

// ReleaseBuckets deletes the B2 bucket and key of every Luna that matches. lunaSlot "" matches
// every Luna on the account. The bucket must already be empty: B2 refuses to delete one that
// holds files, and then its row stays so nothing is lost track of. Buckets are freed after a
// purge so the B2 account's bucket limit is spent only on Lunas that still have backups.
func (p *BucketProvisioner) ReleaseBuckets(accountID, lunaSlot string) error {
	if accountID == "" {
		return nil
	}
	var rows *sql.Rows
	var err error
	if lunaSlot != "" {
		rows, err = p.DB.Query(`SELECT device_id, bucket_id, key_id FROM device_backup_buckets WHERE device_id = ?`,
			BucketKey(accountID, lunaSlot))
	} else {
		rows, err = p.DB.Query(`SELECT device_id, bucket_id, key_id FROM device_backup_buckets WHERE substr(device_id, 1, ?) = ?`,
			len(accountID)+1, accountID+":")
	}
	if err != nil {
		return err
	}
	type row struct{ id, bucketID, keyID string }
	var found []row
	for rows.Next() {
		var r row
		if err := rows.Scan(&r.id, &r.bucketID, &r.keyID); err != nil {
			rows.Close()
			return err
		}
		found = append(found, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(found) == 0 {
		return nil
	}

	prov, err := p.Providers.FindEnabled("backup")
	if err != nil {
		return fmt.Errorf("could not look up backup connection: %w", err)
	}
	if prov == nil {
		return ErrBackupNotConfigured
	}
	masterID, masterKey := prov.Credential("account_id", ""), prov.Credential("application_key", "")
	if strings.TrimSpace(masterID) == "" || strings.TrimSpace(masterKey) == "" {
		return ErrBackupNotConfigured
	}
	b2 := p.B2
	if b2 == nil {
		b2 = NewB2Client(nil)
	}
	var firstErr error
	for _, r := range found {
		// Delete the bucket first: if it still holds files B2 refuses, and the key must stay
		// so those files can still be reached and removed.
		if err := b2.DeleteBucket(masterID, masterKey, r.bucketID); err != nil {
			if firstErr == nil {
				firstErr = err
			}
			continue
		}
		if err := b2.DeleteKey(masterID, masterKey, r.keyID); err != nil && firstErr == nil {
			firstErr = err
		}
		if _, err := p.DB.Exec(`DELETE FROM device_backup_buckets WHERE device_id = ?`, r.id); err != nil && firstErr == nil {
			firstErr = err
		}
	}
	return firstErr
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
