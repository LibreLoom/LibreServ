package handlers

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

const (
	maxStoragePackBytes   = 64 << 20
	maxStorageRecordBytes = 1 << 20
	identityKind          = "identity"
	identityPublicName    = "public"
	// storageSigWindow is how far, in seconds, a move signature's timestamp may
	// differ from the server clock.
	storageSigWindow = 300
)

var (
	storageLunaIDPattern = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)
	storageScopePattern  = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)
	storagePackIDPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	storageNamePattern   = regexp.MustCompile(`^[a-z0-9._-]{1,128}$`)
)

// StorageHandler serves /api/v1/storage: content-addressed packs and small
// named records, kept per account and per Luna. Connect never reads the bytes.
type StorageHandler struct {
	Deps
}

// storageAccount returns the account of the calling device.
func storageAccount(w http.ResponseWriter, r *http.Request) (string, bool) {
	dev, found := DeviceFrom(r.Context())
	if !found || !dev.AccountID.Valid {
		JSONError(w, http.StatusForbidden, "Link this Luna at connect.luna.libreloom.org first.")
		return "", false
	}
	return dev.AccountID.String, true
}

// deviceIDFrom returns the id of the calling device. Call it only after storageAccount.
func deviceIDFrom(r *http.Request) string {
	dev, _ := DeviceFrom(r.Context())
	return dev.ID
}

// storageScope checks the device and the X-Luna-Id header, then returns the
// account and the Luna id that the call is scoped to.
func storageScope(d Deps, w http.ResponseWriter, r *http.Request) (accountID, lunaID string, ok bool) {
	accountID, ok = storageAccount(w, r)
	if !ok {
		return "", "", false
	}
	lunaID = strings.TrimSpace(r.Header.Get("X-Luna-Id"))
	if !storageLunaIDPattern.MatchString(lunaID) {
		JSONError(w, http.StatusBadRequest, "Luna did not say which Luna is asking. Update Luna and try again.")
		return "", "", false
	}
	// Only a PUT may claim a Luna. Other calls find the Luna's existing owner and
	// never create a row.
	if !authorizeLuna(d, w, r, accountID, lunaID, deviceIDFrom(r), r.Method == http.MethodPut) {
		return "", "", false
	}
	return accountID, lunaID, true
}

// validStorageName accepts the documented pattern and rejects dot segments,
// so a name can never climb out of its folder.
func validStorageName(s string) bool {
	return storageNamePattern.MatchString(s) && s != "." && !strings.Contains(s, "..")
}

// bindLuna returns the device that owns a Luna's cloud storage and the Luna's
// registered signing key (hex, empty until one is set). The first device to use
// a Luna id claims it.
func bindLuna(d Deps, accountID, lunaID, deviceID string) (boundDevice, signingHex string, err error) {
	const query = `SELECT device_id, signing_public FROM luna_ids WHERE account_id = ? AND luna_id = ?`
	err = d.DB.QueryRow(query, accountID, lunaID).Scan(&boundDevice, &signingHex)
	if errors.Is(err, sql.ErrNoRows) {
		if _, err = d.DB.Exec(`INSERT INTO luna_ids (account_id, luna_id, device_id, signing_public, created_at)
VALUES (?, ?, ?, '', ?)
ON CONFLICT(account_id, luna_id) DO NOTHING`, accountID, lunaID, deviceID, time.Now().Unix()); err != nil {
			return "", "", err
		}
		err = d.DB.QueryRow(query, accountID, lunaID).Scan(&boundDevice, &signingHex)
	}
	return boundDevice, signingHex, err
}

// lookupLuna returns the owning device and signing key of a Luna without creating
// a row. found is false when the account has never claimed this Luna.
func lookupLuna(d Deps, accountID, lunaID string) (boundDevice, signingHex string, found bool, err error) {
	err = d.DB.QueryRow(`SELECT device_id, signing_public FROM luna_ids WHERE account_id = ? AND luna_id = ?`,
		accountID, lunaID).Scan(&boundDevice, &signingHex)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", false, nil
	}
	return boundDevice, signingHex, err == nil, err
}

// lunaSigValid reports whether the request carries a fresh signature, made with the
// Luna's registered signing key, that moves this Luna to a new device. The signed
// message is the domain prefix, the Luna id, a zero byte and X-Luna-Ts.
func lunaSigValid(r *http.Request, signingHex, lunaID string, now time.Time) bool {
	pub, err := hex.DecodeString(signingHex)
	if err != nil || len(pub) != ed25519.PublicKeySize {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(r.Header.Get("X-Luna-Sig")))
	if err != nil || len(sig) != ed25519.SignatureSize {
		return false
	}
	ts := strings.TrimSpace(r.Header.Get("X-Luna-Ts"))
	sentAt, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return false
	}
	if skew := now.Unix() - sentAt; skew < -storageSigWindow || skew > storageSigWindow {
		return false
	}
	msg := []byte("luna-sig-v1\x00move\x00" + lunaID + "\x00" + ts)
	return ed25519.Verify(pub, msg, sig)
}

// authorizeLuna lets the calling device use a Luna's storage. A PUT (write) claims an
// unclaimed Luna for the calling device. Any other call only reads the owner, so an
// unknown Luna simply has nothing stored. A device that is not the owner may take the
// Luna over only with a fresh X-Luna-Sig from that Luna's signing key, and then it
// becomes the owner.
func authorizeLuna(d Deps, w http.ResponseWriter, r *http.Request, accountID, lunaID, deviceID string, write bool) bool {
	var bound, signing string
	var found bool
	var err error
	if write {
		bound, signing, err = bindLuna(d, accountID, lunaID, deviceID)
		found = err == nil
	} else {
		bound, signing, found, err = lookupLuna(d, accountID, lunaID)
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not check this Luna. Try again.")
		return false
	}
	if !found {
		return true
	}
	if bound == deviceID {
		keepLuna(d, accountID, lunaID)
		return true
	}
	if !lunaSigValid(r, signing, lunaID, time.Now()) {
		JSONError(w, http.StatusForbidden, "This Luna's cloud storage belongs to another device on your account.")
		return false
	}
	if _, err := d.DB.Exec(`UPDATE luna_ids SET device_id = ? WHERE account_id = ? AND luna_id = ?`,
		deviceID, accountID, lunaID); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not check this Luna. Try again.")
		return false
	}
	keepLuna(d, accountID, lunaID)
	return true
}

// keepLuna cancels a pending purge: the Luna is linked and using its storage again.
func keepLuna(d Deps, accountID, lunaID string) {
	_, _ = d.DB.Exec(`UPDATE luna_ids SET purge_after = 0 WHERE account_id = ? AND luna_id = ? AND purge_after != 0`, accountID, lunaID)
}

// setSigningPublic records the signing key a Luna uses to move its storage to a new
// device. Once a key is set, only the device that owns the Luna can change the owner.
func setSigningPublic(d Deps, w http.ResponseWriter, accountID, lunaID, deviceID, keyHex string) bool {
	keyHex = strings.ToLower(strings.TrimSpace(keyHex))
	if pub, err := hex.DecodeString(keyHex); err != nil || len(pub) != ed25519.PublicKeySize {
		JSONError(w, http.StatusBadRequest, "That signing key is not valid. Update Luna and try again.")
		return false
	}
	bound, _, err := bindLuna(d, accountID, lunaID, deviceID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not check this Luna. Try again.")
		return false
	}
	if bound != deviceID {
		JSONError(w, http.StatusForbidden, "This Luna's cloud storage belongs to another device on your account.")
		return false
	}
	if _, err := d.DB.Exec(`UPDATE luna_ids SET signing_public = ?, device_id = ? WHERE account_id = ? AND luna_id = ?`,
		keyHex, deviceID, accountID, lunaID); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not save that signing key. Try again.")
		return false
	}
	return true
}

// removeStored deletes a blob from the backend that holds it. A missing blob is not an
// error: the row that pointed at it is already gone, so the only result is a log line.
func (h StorageHandler) removeStored(backend, accountID, deviceID, relPath string) {
	var err error
	if ad, ok := h.Store.(interface {
		DeleteBackend(backend, accountID, deviceID, relPath string) error
	}); ok && backend != "" {
		err = ad.DeleteBackend(backend, accountID, deviceID, relPath)
	} else {
		err = h.Store.Delete(accountID, deviceID, relPath)
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		slog.Warn("storage: a deleted piece could not be removed from its backend", "backend", backend, "error", err)
	}
}

func storageUsed(h Deps, accountID string) int64 {
	var used int64
	_ = h.DB.QueryRow(`SELECT COALESCE((SELECT SUM(size) FROM storage_packs WHERE account_id = ?), 0)
+ COALESCE((SELECT SUM(bytes) FROM storage_records WHERE account_id = ?), 0)`, accountID, accountID).Scan(&used)
	return used
}

func storageFull(w http.ResponseWriter) {
	JSONError(w, http.StatusInsufficientStorage, "Your cloud storage is full.")
}

func (h StorageHandler) PutPack(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, ok := storageScope(h.Deps, w, r)
	if !ok {
		return
	}
	if !backupUnlocked(h.Deps, accountID) {
		JSONError(w, http.StatusPaymentRequired, "Add a payment card at connect.luna.libreloom.org so we can store your cloud backup. It costs $8 per terabyte each month.")
		return
	}
	id := chi.URLParam(r, "id")
	if !storagePackIDPattern.MatchString(id) {
		JSONError(w, http.StatusBadRequest, "That pack ID is not valid. Try the upload again from Luna.")
		return
	}
	scope := strings.TrimSpace(r.Header.Get("X-Luna-Scope"))
	if scope != "" && !storageScopePattern.MatchString(scope) {
		JSONError(w, http.StatusBadRequest, "That pack label is not valid. Try the upload again from Luna.")
		return
	}

	var existing int
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM storage_packs WHERE account_id = ? AND luna_id = ? AND id = ?`,
		accountID, lunaID, id).Scan(&existing)
	if existing > 0 {
		JSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "created": false})
		return
	}

	remain := accountBackupCap(h.Deps, accountID) - storageUsed(h.Deps, accountID)
	if remain <= 0 {
		storageFull(w)
		return
	}
	limit := int64(maxStoragePackBytes)
	if remain < limit {
		limit = remain
	}
	slot := store.StorageSlot(lunaID)
	rel := store.StoragePackPath(id)

	// Spool the body and check its hash before the store is touched. A mismatched
	// upload then never replaces bytes that are already stored under this ID.
	spool, err := os.CreateTemp("", "luna-pack-*")
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not save that data. Try again.")
		return
	}
	defer func() {
		_ = spool.Close()
		_ = os.Remove(spool.Name())
	}()
	hasher := sha256.New()
	limited := http.MaxBytesReader(w, r.Body, limit)
	if _, err := io.Copy(io.MultiWriter(spool, hasher), limited); err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			if remain < maxStoragePackBytes {
				storageFull(w)
				return
			}
			JSONError(w, http.StatusRequestEntityTooLarge, "That data is too large to store in cloud storage. The limit is 64 MB per piece.")
			return
		}
		JSONError(w, http.StatusBadRequest, "Cloud storage could not save that data. Check your connection and try again.")
		return
	}
	if hex.EncodeToString(hasher.Sum(nil)) != id {
		JSONError(w, http.StatusBadRequest, "The data did not match its ID. Try the upload again from Luna.")
		return
	}
	if _, err := spool.Seek(0, io.SeekStart); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not save that data. Try again.")
		return
	}
	n, backend, err := h.Store.Put(accountID, slot, rel, spool)
	if err != nil {
		if errors.Is(err, providers.ErrBackupNotConfigured) {
			JSONError(w, http.StatusServiceUnavailable, "Cloud storage is not ready yet. Contact support and we will finish setting it up.")
			return
		}
		JSONError(w, http.StatusBadRequest, "Cloud storage could not save that data. Check your connection and try again.")
		return
	}
	// If this insert fails the stored bytes are left in place: a concurrent upload of
	// the same pack may have recorded them, and an unrecorded copy is harmless.
	if err := recordPack(h.DB.DB, accountID, lunaID, id, scope, n, backend); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not record that data. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "size": n, "created": true})
}

// recordPack saves where a pack's bytes live. If a concurrent upload of the same pack
// already recorded a row, the row takes the backend that now holds the bytes.
func recordPack(db *sql.DB, accountID, lunaID, id, scope string, size int64, backend string) error {
	_, err := db.Exec(`INSERT INTO storage_packs (account_id, luna_id, id, scope, size, storage_backend, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(account_id, luna_id, id) DO UPDATE SET storage_backend = excluded.storage_backend`,
		accountID, lunaID, id, scope, size, backend, time.Now().Unix())
	return err
}

func (h StorageHandler) GetPack(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, ok := storageScope(h.Deps, w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	if !storagePackIDPattern.MatchString(id) {
		JSONError(w, http.StatusNotFound, "That pack is not in cloud storage.")
		return
	}
	var size int64
	if err := h.DB.QueryRow(`SELECT size FROM storage_packs WHERE account_id = ? AND luna_id = ? AND id = ?`,
		accountID, lunaID, id).Scan(&size); err != nil {
		JSONError(w, http.StatusNotFound, "That pack is not in cloud storage.")
		return
	}
	rc, err := h.Store.Get(accountID, store.StorageSlot(lunaID), store.StoragePackPath(id))
	if err != nil {
		JSONError(w, http.StatusNotFound, "That pack is not in cloud storage.")
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	n, err := io.Copy(w, rc)
	if err == nil && n > 0 {
		billing.RecordEgress(h.DB, accountID, n)
	}
}

func (h StorageHandler) DeletePack(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, ok := storageScope(h.Deps, w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	if !storagePackIDPattern.MatchString(id) {
		JSONError(w, http.StatusNotFound, "That pack is not in cloud storage.")
		return
	}
	var backend string
	_ = h.DB.QueryRow(`SELECT COALESCE(storage_backend, '') FROM storage_packs WHERE account_id = ? AND luna_id = ? AND id = ?`,
		accountID, lunaID, id).Scan(&backend)
	res, err := h.DB.Exec(`DELETE FROM storage_packs WHERE account_id = ? AND luna_id = ? AND id = ?`,
		accountID, lunaID, id)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not delete that pack. Try again.")
		return
	}
	// Remove the bytes only when this call removed the row. A pack that is already
	// gone still counts as deleted, so retries are safe and never touch the store.
	if n, _ := res.RowsAffected(); n > 0 {
		h.removeStored(backend, accountID, store.StorageSlot(lunaID), store.StoragePackPath(id))
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h StorageHandler) PutRecord(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, ok := storageScope(h.Deps, w, r)
	if !ok {
		return
	}
	if !backupUnlocked(h.Deps, accountID) {
		JSONError(w, http.StatusPaymentRequired, "Add a payment card at connect.luna.libreloom.org so we can store your cloud backup. It costs $8 per terabyte each month.")
		return
	}
	kind, name := chi.URLParam(r, "kind"), chi.URLParam(r, "name")
	if !validStorageName(kind) || !validStorageName(name) {
		JSONError(w, http.StatusBadRequest, "That record name is not valid. Use only lowercase letters, numbers, dots, dashes and underscores.")
		return
	}
	data, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxStorageRecordBytes))
	if err != nil {
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			JSONError(w, http.StatusRequestEntityTooLarge, "That record is too large. The limit is 1 MB.")
			return
		}
		JSONError(w, http.StatusBadRequest, "Could not read that record. Try again.")
		return
	}
	// The identity public record carries the Luna's signing key, which later device
	// moves are checked against.
	if kind == identityKind && name == identityPublicName {
		if !setSigningPublic(h.Deps, w, accountID, lunaID, deviceIDFrom(r), string(data)) {
			return
		}
	}

	var oldBytes int64
	_ = h.DB.QueryRow(`SELECT bytes FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ? AND name = ?`,
		accountID, lunaID, kind, name).Scan(&oldBytes)
	used := storageUsed(h.Deps, accountID) - oldBytes
	if used+int64(len(data)) > accountBackupCap(h.Deps, accountID) {
		storageFull(w)
		return
	}

	slot := store.StorageSlot(lunaID)
	rel := store.StorageRecordPath(kind, name)
	n, backend, err := h.Store.Put(accountID, slot, rel, bytes.NewReader(data))
	if err != nil {
		if errors.Is(err, providers.ErrBackupNotConfigured) {
			JSONError(w, http.StatusServiceUnavailable, "Cloud storage is not ready yet. Contact support and we will finish setting it up.")
			return
		}
		JSONError(w, http.StatusBadRequest, "Cloud storage could not save that record. Check your connection and try again.")
		return
	}
	if _, err := h.DB.Exec(`INSERT INTO storage_records (account_id, luna_id, kind, name, bytes, storage_backend, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(account_id, luna_id, kind, name) DO UPDATE SET bytes = excluded.bytes, storage_backend = excluded.storage_backend, updated_at = excluded.updated_at`,
		accountID, lunaID, kind, name, n, backend, time.Now().Unix()); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not record that save. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true, "bytes": n})
}

func (h StorageHandler) GetRecord(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, ok := storageScope(h.Deps, w, r)
	if !ok {
		return
	}
	kind, name := chi.URLParam(r, "kind"), chi.URLParam(r, "name")
	if !validStorageName(kind) || !validStorageName(name) {
		JSONError(w, http.StatusNotFound, "That record is not in cloud storage.")
		return
	}
	var size int64
	if err := h.DB.QueryRow(`SELECT bytes FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ? AND name = ?`,
		accountID, lunaID, kind, name).Scan(&size); err != nil {
		JSONError(w, http.StatusNotFound, "That record is not in cloud storage.")
		return
	}
	rc, err := h.Store.Get(accountID, store.StorageSlot(lunaID), store.StorageRecordPath(kind, name))
	if err != nil {
		JSONError(w, http.StatusNotFound, "That record is not in cloud storage.")
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	n, err := io.Copy(w, rc)
	if err == nil && n > 0 {
		billing.RecordEgress(h.DB, accountID, n)
	}
}

// DeleteRecord is idempotent: deleting a record that is already gone is a success.
func (h StorageHandler) DeleteRecord(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, ok := storageScope(h.Deps, w, r)
	if !ok {
		return
	}
	kind, name := chi.URLParam(r, "kind"), chi.URLParam(r, "name")
	if !validStorageName(kind) || !validStorageName(name) {
		JSONError(w, http.StatusBadRequest, "That record name is not valid. Use only lowercase letters, numbers, dots, dashes and underscores.")
		return
	}
	var backend string
	_ = h.DB.QueryRow(`SELECT COALESCE(storage_backend, '') FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ? AND name = ?`,
		accountID, lunaID, kind, name).Scan(&backend)
	res, err := h.DB.Exec(`DELETE FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ? AND name = ?`,
		accountID, lunaID, kind, name)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not delete that record. Try again.")
		return
	}
	if n, _ := res.RowsAffected(); n > 0 {
		h.removeStored(backend, accountID, store.StorageSlot(lunaID), store.StorageRecordPath(kind, name))
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h StorageHandler) ListRecords(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, ok := storageScope(h.Deps, w, r)
	if !ok {
		return
	}
	kind := chi.URLParam(r, "kind")
	if !validStorageName(kind) {
		JSONError(w, http.StatusBadRequest, "That record kind is not valid. Use only lowercase letters, numbers, dots, dashes and underscores.")
		return
	}
	rows, err := h.DB.Query(`SELECT name FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ? ORDER BY name`,
		accountID, lunaID, kind)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not list those records. Try again.")
		return
	}
	defer rows.Close()
	names := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err == nil {
			names = append(names, name)
		}
	}
	JSON(w, http.StatusOK, map[string]any{"names": names})
}

// ListLunaIDs returns the Lunas on the calling account, and whether each has a signing key.
func (h StorageHandler) ListLunaIDs(w http.ResponseWriter, r *http.Request) {
	accountID, ok := storageAccount(w, r)
	if !ok {
		return
	}
	rows, err := h.DB.Query(`SELECT luna_id, signing_public, created_at FROM luna_ids WHERE account_id = ? ORDER BY luna_id`, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not list your Lunas. Try again.")
		return
	}
	defer rows.Close()
	lunas := []map[string]any{}
	for rows.Next() {
		var lunaID, signing string
		var created int64
		if err := rows.Scan(&lunaID, &signing, &created); err == nil {
			lunas = append(lunas, map[string]any{
				"luna_id":         lunaID,
				"has_signing_key": signing != "",
				"created_at":      created,
			})
		}
	}
	JSON(w, http.StatusOK, map[string]any{"luna_ids": lunas})
}

// SetSigningPublic registers a Luna's signing key from the request body (64 hex characters).
func (h StorageHandler) SetSigningPublic(w http.ResponseWriter, r *http.Request) {
	accountID, ok := storageAccount(w, r)
	if !ok {
		return
	}
	lunaID := chi.URLParam(r, "id")
	if !storageLunaIDPattern.MatchString(lunaID) {
		JSONError(w, http.StatusBadRequest, "That Luna ID is not valid. Update Luna and try again.")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256))
	if err != nil {
		JSONError(w, http.StatusBadRequest, "Could not read that signing key. Try again.")
		return
	}
	if !setSigningPublic(h.Deps, w, accountID, lunaID, deviceIDFrom(r), string(body)) {
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h StorageHandler) Usage(w http.ResponseWriter, r *http.Request) {
	accountID, _, ok := storageScope(h.Deps, w, r)
	if !ok {
		return
	}
	JSON(w, http.StatusOK, map[string]any{
		"used_bytes":  storageUsed(h.Deps, accountID),
		"quota_bytes": accountBackupCap(h.Deps, accountID),
	})
}

func backupUnlocked(h Deps, accountID string) bool {
	if accountID == "" {
		return false
	}
	var has int
	var status string
	err := h.DB.QueryRow(`SELECT has_card, billing_status FROM accounts WHERE id = ?`, accountID).Scan(&has, &status)
	return err == nil && billing.BackupsUnlocked(has == 1, status)
}

func accountBackupCap(h Deps, accountID string) int64 {
	var quota sql.NullInt64
	_ = h.DB.QueryRow(`SELECT backup_quota_bytes FROM accounts WHERE id = ?`, accountID).Scan(&quota)
	if quota.Valid && quota.Int64 > 0 {
		return quota.Int64
	}
	if config.C.Backup.MaxAccountBytes > 0 {
		return config.C.Backup.MaxAccountBytes
	}
	return 2_000_000_000_000
}
