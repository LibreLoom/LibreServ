package handlers

import (
	"bytes"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/database"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

const (
	maxStoragePackBytes   = 64 << 20
	maxStorageRecordBytes = 1 << 20
	identityKind          = "identity"
	identityPublicName    = "public"
	// maxLunasPerAccount caps the Luna IDs one account can claim. Each Luna that stores
	// something gets its own Backblaze bucket, and the Backblaze account allows only so many.
	maxLunasPerAccount = 25
	// storageSigWindow is how far, in seconds, a move signature's timestamp may
	// differ from the server clock.
	storageSigWindow         = 300
	maxStorageRecordPageSize = 256
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
func storageScope(d Deps, w http.ResponseWriter, r *http.Request) (accountID, lunaID string, tx *database.Tx, ok bool) {
	accountID, ok = storageAccount(w, r)
	if !ok {
		return "", "", nil, false
	}
	lunaID = strings.TrimSpace(r.Header.Get("X-Luna-Id"))
	if !storageLunaIDPattern.MatchString(lunaID) {
		JSONError(w, http.StatusBadRequest, "Luna did not say which Luna is asking. Update Luna and try again.")
		return "", "", nil, false
	}
	tx, err := d.DB.BeginTx(r.Context(), nil)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not check this Luna. Try again.")
		return "", "", nil, false
	}
	if err := database.LockStorageAccountWrite(tx, accountID); err != nil {
		_ = tx.Rollback()
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not check this Luna. Try again.")
		return "", "", nil, false
	}
	// Only a PUT may claim a Luna. Other calls find the Luna's existing owner and
	// never create a row.
	if !authorizeLuna(tx, w, r, accountID, lunaID, deviceIDFrom(r), r.Method == http.MethodPut) {
		_ = tx.Rollback()
		return "", "", nil, false
	}
	if r.Method != http.MethodPut && r.Method != http.MethodDelete {
		if err := tx.Commit(); err != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not check this Luna. Try again.")
			return "", "", nil, false
		}
		return accountID, lunaID, nil, true
	}
	return accountID, lunaID, tx, true
}

type storageQueryExec interface {
	Exec(query string, args ...any) (sql.Result, error)
	QueryRow(query string, args ...any) *sql.Row
}

// validStorageName accepts the documented pattern and rejects dot segments,
// so a name can never climb out of its folder.
func validStorageName(s string) bool {
	return storageNamePattern.MatchString(s) && s != "." && !strings.Contains(s, "..")
}

// bindLuna returns the device that owns a Luna's cloud storage and the Luna's
// registered signing key (hex, empty until one is set). The first device to use
// a Luna id claims it.
func bindLuna(exec storageQueryExec, accountID, lunaID, deviceID string) (boundDevice, signingHex string, err error) {
	const query = `SELECT device_id, signing_public FROM luna_ids WHERE account_id = ? AND luna_id = ?`
	err = exec.QueryRow(query, accountID, lunaID).Scan(&boundDevice, &signingHex)
	if errors.Is(err, sql.ErrNoRows) {
		// One statement counts and inserts, so parallel claims cannot pass the cap together.
		if _, err = exec.Exec(`INSERT INTO luna_ids (account_id, luna_id, device_id, signing_public, created_at)
SELECT ?, ?, ?, '', ?
WHERE (SELECT COUNT(*) FROM luna_ids WHERE account_id = ?) < ?
ON CONFLICT(account_id, luna_id) DO NOTHING`, accountID, lunaID, deviceID, time.Now().Unix(),
			accountID, maxLunasPerAccount); err != nil {
			return "", "", err
		}
		err = exec.QueryRow(query, accountID, lunaID).Scan(&boundDevice, &signingHex)
		if errors.Is(err, sql.ErrNoRows) {
			return "", "", errLunaLimit
		}
	}
	return boundDevice, signingHex, err
}

// lookupLuna reads a Luna's owner and signing key without claiming or changing it.
// Share-link handlers use this to verify signed private-scope records.
func lookupLuna(d Deps, accountID, lunaID string) (boundDevice, signingHex string, found bool, err error) {
	err = d.DB.QueryRow(`SELECT device_id, signing_public FROM luna_ids WHERE account_id = ? AND luna_id = ?`,
		accountID, lunaID).Scan(&boundDevice, &signingHex)
	if errors.Is(err, sql.ErrNoRows) {
		return "", "", false, nil
	}
	return boundDevice, signingHex, err == nil, err
}

// errLunaLimit means the account already holds maxLunasPerAccount Luna IDs.
var errLunaLimit = errors.New("too many Lunas on this account")

// writeLunaBindError answers a failed bindLuna: the cap gets its own sentence, anything else is a retry.
func writeLunaBindError(w http.ResponseWriter, err error) {
	if errors.Is(err, errLunaLimit) {
		JSONError(w, http.StatusConflict, "This account already has 25 Lunas with cloud backups. Delete the backups of one you no longer use, then try again.")
		return
	}
	JSONError(w, http.StatusInternalServerError, "Cloud storage could not check this Luna. Try again.")
}

// lunaSigValid reports whether the request carries a fresh signature, made with the
// Luna's registered signing key, that moves this Luna to a new device. The signed
// message is the domain prefix, the Luna id, a zero byte and X-Luna-Ts.
func lunaSigValid(r *http.Request, signingHex, lunaID string, now time.Time) bool {
	pub, err := hex.DecodeString(signingHex)
	if err != nil || len(pub) != lunaSigPublicLen {
		return false
	}
	sig, err := base64.StdEncoding.DecodeString(strings.TrimSpace(r.Header.Get("X-Luna-Sig")))
	if err != nil || len(sig) != lunaSigLen {
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
	return lunaVerify(pub, "move", []byte(lunaID+"\x00"+ts), sig)
}

// authorizeLuna lets the calling device use a Luna's storage. A PUT (write) claims an
// unclaimed Luna for the calling device. Any other call only reads the owner, so an
// unknown Luna simply has nothing stored. A device that is not the owner may take the
// Luna over only with a fresh X-Luna-Sig from that Luna's signing key, and then it
// becomes the owner.
func authorizeLuna(exec storageQueryExec, w http.ResponseWriter, r *http.Request, accountID, lunaID, deviceID string, write bool) bool {
	var bound, signing string
	var found bool
	var err error
	if write {
		bound, signing, err = bindLuna(exec, accountID, lunaID, deviceID)
		found = err == nil
	} else {
		err = exec.QueryRow(`SELECT device_id, signing_public FROM luna_ids WHERE account_id = ? AND luna_id = ?`,
			accountID, lunaID).Scan(&bound, &signing)
		if errors.Is(err, sql.ErrNoRows) {
			err = nil
		} else {
			found = err == nil
		}
	}
	if err != nil {
		writeLunaBindError(w, err)
		return false
	}
	if !found {
		return true
	}
	if bound == deviceID {
		keepLunaWith(exec, accountID, lunaID)
		return true
	}
	if !lunaSigValid(r, signing, lunaID, time.Now()) {
		JSONError(w, http.StatusForbidden, "This Luna's cloud storage belongs to another device on your account.")
		return false
	}
	if _, err := exec.Exec(`UPDATE luna_ids SET device_id = ? WHERE account_id = ? AND luna_id = ?`,
		deviceID, accountID, lunaID); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not check this Luna. Try again.")
		return false
	}
	keepLunaWith(exec, accountID, lunaID)
	return true
}

// keepLuna cancels a pending purge, or one that was claimed and never finished: the Luna is
// linked and using its storage again.
func keepLuna(d Deps, accountID, lunaID string) {
	_, _ = d.DB.Exec(`UPDATE luna_ids SET purge_after = 0 WHERE account_id = ? AND luna_id = ? AND (purge_after > 0 OR purge_after = -1)`, accountID, lunaID)
}

func keepLunaWith(exec storageQueryExec, accountID, lunaID string) {
	_, _ = exec.Exec(`UPDATE luna_ids SET purge_after = 0 WHERE account_id = ? AND luna_id = ? AND (purge_after > 0 OR purge_after = -1)`, accountID, lunaID)
}

// setSigningPublic records the signing key a Luna uses to move its storage to a new
// device. Once a key is set, only the device that owns the Luna can change the owner.
func setSigningPublic(exec storageQueryExec, w http.ResponseWriter, accountID, lunaID, deviceID, keyHex string) bool {
	keyHex = strings.ToLower(strings.TrimSpace(keyHex))
	if pub, err := hex.DecodeString(keyHex); err != nil || len(pub) != lunaSigPublicLen {
		JSONError(w, http.StatusBadRequest, "That signing key is not valid. Update Luna and try again.")
		return false
	}
	bound, _, err := bindLuna(exec, accountID, lunaID, deviceID)
	if err != nil {
		writeLunaBindError(w, err)
		return false
	}
	if bound != deviceID {
		JSONError(w, http.StatusForbidden, "This Luna's cloud storage belongs to another device on your account.")
		return false
	}
	if _, err := exec.Exec(`UPDATE luna_ids SET signing_public = ?, device_id = ? WHERE account_id = ? AND luna_id = ?`,
		keyHex, deviceID, accountID, lunaID); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not save that signing key. Try again.")
		return false
	}
	return true
}

// deleteGraceSeconds is how long the bytes of a deleted pack or record stay in storage after Luna
// deletes them. Luna's row disappears at once, so the data is gone from the user's side, but a stolen
// device token or a bug in Luna cannot destroy the off-site copy faster than support can notice.
const deleteGraceSeconds = 7 * 24 * 3600

// removeStored schedules a deleted blob for removal from the backend that holds it. The row that
// pointed at it is already gone. A background job removes the bytes after deleteGraceSeconds and
// retries until the backend confirms, so a failed removal never leaves bytes behind for good.
// A blob that is uploaded again before then is kept (see cancelRemoval).
func removeStored(exec storageQueryExec, backend, accountID, lunaID, relPath string) error {
	_, err := exec.Exec(`INSERT INTO storage_pending_deletes (account_id, luna_id, path, storage_backend, delete_after)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(account_id, luna_id, path) DO NOTHING`,
		accountID, lunaID, relPath, backend, time.Now().Unix()+deleteGraceSeconds)
	return err
}

// cancelRemoval keeps a blob that was deleted and then stored again.
func cancelRemoval(d Deps, accountID, lunaID, relPath string) {
	_, _ = d.DB.Exec(`DELETE FROM storage_pending_deletes WHERE account_id = ? AND luna_id = ? AND path = ?`,
		accountID, lunaID, relPath)
}

func storageUsed(exec storageQueryExec, accountID string) int64 {
	var used int64
	_ = exec.QueryRow(`SELECT COALESCE((SELECT SUM(size) FROM storage_packs WHERE account_id = ?), 0)
+ COALESCE((SELECT SUM(bytes) FROM storage_records WHERE account_id = ?), 0)`, accountID, accountID).Scan(&used)
	return used
}

func storageFull(w http.ResponseWriter) {
	JSONError(w, http.StatusInsufficientStorage, "Your cloud storage is full.")
}

func (h StorageHandler) PutPack(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, tx, ok := storageScope(h.Deps, w, r)
	if !ok {
		return
	}
	defer tx.Rollback()
	if !backupUnlocked(tx, accountID) {
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
	_ = tx.QueryRow(`SELECT COUNT(*) FROM storage_packs WHERE account_id = ? AND luna_id = ? AND id = ?`,
		accountID, lunaID, id).Scan(&existing)
	if existing > 0 {
		if err := tx.Commit(); err != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not check that data. Try again.")
			return
		}
		JSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "created": false})
		return
	}

	remain := accountBackupCap(tx, accountID) - storageUsed(tx, accountID)
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
	if err := recordPack(tx, accountID, lunaID, id, scope, n, backend); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not record that data. Try again.")
		return
	}
	if err := tx.Commit(); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not record that data. Try again.")
		return
	}
	cancelRemoval(h.Deps, accountID, lunaID, rel)
	JSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "size": n, "created": true})
}

// recordPack saves where a pack's bytes live. If a concurrent upload of the same pack
// already recorded a row, the row takes the backend that now holds the bytes.
func recordPack(db storageQueryExec, accountID, lunaID, id, scope string, size int64, backend string) error {
	_, err := db.Exec(`INSERT INTO storage_packs (account_id, luna_id, id, scope, size, storage_backend, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(account_id, luna_id, id) DO UPDATE SET storage_backend = excluded.storage_backend`,
		accountID, lunaID, id, scope, size, backend, time.Now().Unix())
	return err
}

func (h StorageHandler) GetPack(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, _, ok := storageScope(h.Deps, w, r)
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
	accountID, lunaID, tx, ok := storageScope(h.Deps, w, r)
	if !ok {
		return
	}
	defer tx.Rollback()
	id := chi.URLParam(r, "id")
	if !storagePackIDPattern.MatchString(id) {
		JSONError(w, http.StatusNotFound, "That pack is not in cloud storage.")
		return
	}
	var backend string
	err := tx.QueryRow(`SELECT COALESCE(storage_backend, '') FROM storage_packs WHERE account_id = ? AND luna_id = ? AND id = ?`,
		accountID, lunaID, id).Scan(&backend)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not delete that pack. Try again.")
		return
	}
	res, err := tx.Exec(`DELETE FROM storage_packs WHERE account_id = ? AND luna_id = ? AND id = ?`,
		accountID, lunaID, id)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not delete that pack. Try again.")
		return
	}
	n, err := res.RowsAffected()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not delete that pack. Try again.")
		return
	}
	if n > 0 {
		if err := removeStored(tx, backend, accountID, lunaID, store.StoragePackPath(id)); err != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not delete that pack. Try again.")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not delete that pack. Try again.")
		return
	}
	// Remove the bytes only when this call removed the row. A pack that is already
	// gone still counts as deleted, so retries are safe and never touch the store.
	w.WriteHeader(http.StatusNoContent)
}

func (h StorageHandler) PutRecord(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, tx, ok := storageScope(h.Deps, w, r)
	if !ok {
		return
	}
	defer tx.Rollback()
	if !backupUnlocked(tx, accountID) {
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
	var oldBytes int64
	_ = tx.QueryRow(`SELECT bytes FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ? AND name = ?`,
		accountID, lunaID, kind, name).Scan(&oldBytes)
	used := storageUsed(tx, accountID) - oldBytes
	if used+int64(len(data)) > accountBackupCap(tx, accountID) {
		storageFull(w)
		return
	}

	// The identity public record carries the Luna's signing key, which later device
	// moves are checked against.
	if kind == identityKind && name == identityPublicName {
		if !setSigningPublic(tx, w, accountID, lunaID, deviceIDFrom(r), string(data)) {
			return
		}
	}
	// Hold the inventory row lock until both the object and its row/version are settled.
	// ListRecords takes the same lock, so no page can accept an intermediate inventory.
	if err := database.BumpStorageRecordVersion(tx, accountID, lunaID); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not prepare that save. Try again.")
		return
	}
	if _, err := tx.Exec(`SAVEPOINT storage_record_row`); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not prepare that save. Try again.")
		return
	}

	slot := store.StorageSlot(lunaID)
	rel := store.StorageRecordPath(kind, name)
	n, backend, err := h.Store.Put(accountID, slot, rel, bytes.NewReader(data))
	if err != nil {
		// A provider may have changed an object before returning an error. Publish
		// the bumped version before releasing the row lock so old pages cannot pass.
		if commitErr := tx.Commit(); commitErr != nil {
			bumpStorageRecordInventory(h.Deps, accountID, lunaID)
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not confirm that save. Try again.")
			return
		}
		if errors.Is(err, providers.ErrBackupNotConfigured) {
			JSONError(w, http.StatusServiceUnavailable, "Cloud storage is not ready yet. Contact support and we will finish setting it up.")
			return
		}
		JSONError(w, http.StatusBadRequest, "Cloud storage could not save that record. Check your connection and try again.")
		return
	}
	if _, err := tx.Exec(`INSERT INTO storage_records (account_id, luna_id, kind, name, bytes, storage_backend, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(account_id, luna_id, kind, name) DO UPDATE SET bytes = excluded.bytes, storage_backend = excluded.storage_backend, updated_at = excluded.updated_at`,
		accountID, lunaID, kind, name, n, backend, time.Now().Unix()); err != nil {
		// Keep the inventory invalidation even when the row write fails. The
		// savepoint lets the transaction commit that version on both SQLite/PG.
		if _, rollbackErr := tx.Exec(`ROLLBACK TO SAVEPOINT storage_record_row`); rollbackErr != nil {
			bumpStorageRecordInventory(h.Deps, accountID, lunaID)
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not record that save. Try again.")
			return
		}
		if commitErr := tx.Commit(); commitErr != nil {
			bumpStorageRecordInventory(h.Deps, accountID, lunaID)
		}
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not record that save. Try again.")
		return
	}
	if err := tx.Commit(); err != nil {
		// A failed commit has an uncertain outcome. Make a best-effort follow-up
		// generation bump so a restored old version cannot be accepted afterward.
		bumpStorageRecordInventory(h.Deps, accountID, lunaID)
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not record that save. Try again.")
		return
	}
	cancelRemoval(h.Deps, accountID, lunaID, rel)
	JSON(w, http.StatusOK, map[string]any{"ok": true, "bytes": n})
}

func bumpStorageRecordInventory(d Deps, accountID, lunaID string) error {
	tx, err := d.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err := database.BumpStorageRecordVersion(tx, accountID, lunaID); err != nil {
		return err
	}
	return tx.Commit()
}

func (h StorageHandler) GetRecord(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, _, ok := storageScope(h.Deps, w, r)
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
	accountID, lunaID, tx, ok := storageScope(h.Deps, w, r)
	if !ok {
		return
	}
	defer tx.Rollback()
	kind, name := chi.URLParam(r, "kind"), chi.URLParam(r, "name")
	if !validStorageName(kind) || !validStorageName(name) {
		JSONError(w, http.StatusBadRequest, "That record name is not valid. Use only lowercase letters, numbers, dots, dashes and underscores.")
		return
	}
	var backend string
	err := tx.QueryRow(`SELECT COALESCE(storage_backend, '') FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ? AND name = ?`,
		accountID, lunaID, kind, name).Scan(&backend)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not delete that record. Try again.")
		return
	}
	res, err := tx.Exec(`DELETE FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ? AND name = ?`,
		accountID, lunaID, kind, name)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not delete that record. Try again.")
		return
	}
	n, err := res.RowsAffected()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not delete that record. Try again.")
		return
	}
	if n > 0 {
		if err := database.BumpStorageRecordVersion(tx, accountID, lunaID); err != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not delete that record. Try again.")
			return
		}
		if err := removeStored(tx, backend, accountID, lunaID, store.StorageRecordPath(kind, name)); err != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not delete that record. Try again.")
			return
		}
	}
	if err := tx.Commit(); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not delete that record. Try again.")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h StorageHandler) ListRecords(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, _, ok := storageScope(h.Deps, w, r)
	if !ok {
		return
	}
	kind := chi.URLParam(r, "kind")
	if !validStorageName(kind) {
		JSONError(w, http.StatusBadRequest, "That record kind is not valid. Use only lowercase letters, numbers, dots, dashes and underscores.")
		return
	}
	if r.URL.Query().Has("limit") || r.URL.Query().Has("after") || r.URL.Query().Has("prefix") || r.URL.Query().Has("version") || r.URL.Query().Has("total") {
		limit, after, prefix, requestedVersion, requestedTotal, err := parseStorageRecordPage(r)
		if err != nil {
			JSONError(w, http.StatusBadRequest, "That backup listing page is not valid. Try again.")
			return
		}
		// This transaction intentionally takes the inventory row write lock. A PUT
		// keeps it while replacing object bytes and publishing the matching DB row.
		tx, err := h.DB.BeginTx(r.Context(), nil)
		if err != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not list those records. Try again.")
			return
		}
		defer tx.Rollback()
		// storageScope checks ownership in its own short transaction. Recheck under
		// the same transaction as the page read so a signed device transfer cannot
		// happen between authorization and returning names.
		if err := database.LockStorageAccountWrite(tx, accountID); err != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not check this Luna. Try again.")
			return
		}
		if !authorizeLuna(tx, w, r, accountID, lunaID, deviceIDFrom(r), false) {
			return
		}
		if err := database.LockStorageRecordInventory(tx, accountID, lunaID); err != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not list those records. Try again.")
			return
		}
		version, versionErr := storageRecordVersion(tx, accountID, lunaID)
		if versionErr != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not list those records. Try again.")
			return
		}
		if requestedVersion != nil && *requestedVersion != version {
			JSONError(w, http.StatusConflict, "The cloud backup list changed during restore. Try restoring again.")
			return
		}
		var total uint64
		if requestedTotal != nil {
			// The first page counted this inventory. Its version is checked above, so later pages
			// can reuse that total without rescanning every record for each small response.
			total = *requestedTotal
		} else {
			var countErr error
			if prefix == "" {
				countErr = tx.QueryRow(`SELECT COUNT(*) FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ?`,
					accountID, lunaID, kind).Scan(&total)
			} else {
				prefixEnd := storageNamePrefixEnd(prefix)
				countErr = tx.QueryRow(`SELECT COUNT(*) FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ? AND name >= ? AND name < ?`,
					accountID, lunaID, kind, prefix, prefixEnd).Scan(&total)
			}
			if countErr != nil {
				JSONError(w, http.StatusInternalServerError, "Cloud storage could not list those records. Try again.")
				return
			}
		}
		var rows *sql.Rows
		if prefix == "" {
			rows, err = tx.Query(`SELECT name FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ? AND name > ? ORDER BY name LIMIT ?`,
				accountID, lunaID, kind, after, limit+1)
		} else {
			prefixEnd := storageNamePrefixEnd(prefix)
			rows, err = tx.Query(`SELECT name FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ? AND name >= ? AND name < ? AND name > ? ORDER BY name LIMIT ?`,
				accountID, lunaID, kind, prefix, prefixEnd, after, limit+1)
		}
		if err != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not list those records. Try again.")
			return
		}
		defer rows.Close()
		names := make([]string, 0, limit+1)
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				JSONError(w, http.StatusInternalServerError, "Cloud storage could not list those records. Try again.")
				return
			}
			names = append(names, name)
		}
		if err := rows.Err(); err != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not list those records. Try again.")
			return
		}
		currentVersion, versionErr := storageRecordVersion(tx, accountID, lunaID)
		if versionErr != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not list those records. Try again.")
			return
		}
		if currentVersion != version {
			JSONError(w, http.StatusConflict, "The cloud backup list changed during restore. Try restoring again.")
			return
		}
		if err := tx.Commit(); err != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not list those records. Try again.")
			return
		}
		var nextAfter *string
		if len(names) > limit {
			names = names[:limit]
			last := names[len(names)-1]
			nextAfter = &last
		}
		JSON(w, http.StatusOK, struct {
			Names     []string `json:"names"`
			Total     uint64   `json:"total"`
			NextAfter *string  `json:"next_after,omitempty"`
			Version   uint64   `json:"version"`
		}{Names: names, Total: total, NextAfter: nextAfter, Version: version})
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

// parseStorageRecordPage requires a bounded limit for every paged request. Cursor names use the
// same restricted alphabet as stored names, so each continuation is safe and unambiguous.
func parseStorageRecordPage(r *http.Request) (limit int, after, prefix string, version, total *uint64, err error) {
	query := r.URL.Query()
	limits := query["limit"]
	if len(limits) != 1 {
		return 0, "", "", nil, nil, errors.New("missing or repeated page limit")
	}
	limit, err = strconv.Atoi(limits[0])
	if err != nil || limit < 1 || limit > maxStorageRecordPageSize {
		return 0, "", "", nil, nil, errors.New("page limit out of range")
	}
	cursors := query["after"]
	if len(cursors) > 1 {
		return 0, "", "", nil, nil, errors.New("repeated page cursor")
	}
	if len(cursors) == 1 {
		after = cursors[0]
		if !validStorageName(after) {
			return 0, "", "", nil, nil, errors.New("invalid page cursor")
		}
	}
	prefixes := query["prefix"]
	if len(prefixes) > 1 {
		return 0, "", "", nil, nil, errors.New("repeated page prefix")
	}
	if len(prefixes) == 1 {
		prefix = prefixes[0]
		if !validStorageName(prefix) || !strings.HasSuffix(prefix, ".") ||
			(after != "" && !strings.HasPrefix(after, prefix)) {
			return 0, "", "", nil, nil, errors.New("invalid page prefix")
		}
	}
	versions := query["version"]
	if len(versions) > 1 {
		return 0, "", "", nil, nil, errors.New("repeated page version")
	}
	if len(versions) == 1 {
		parsed, err := strconv.ParseUint(versions[0], 10, 64)
		if err != nil {
			return 0, "", "", nil, nil, errors.New("invalid page version")
		}
		version = &parsed
	}
	totals := query["total"]
	if len(totals) > 1 {
		return 0, "", "", nil, nil, errors.New("repeated page total")
	}
	if len(totals) == 1 {
		parsed, err := strconv.ParseUint(totals[0], 10, 64)
		if err != nil {
			return 0, "", "", nil, nil, errors.New("invalid page total")
		}
		total = &parsed
	}
	if (version == nil) != (total == nil) || (after != "" && version == nil) {
		return 0, "", "", nil, nil, errors.New("page continuation needs both version and total")
	}
	return limit, after, prefix, version, total, nil
}

func storageRecordVersion(tx *database.Tx, accountID, lunaID string) (uint64, error) {
	var version uint64
	err := tx.QueryRow(`SELECT version FROM storage_record_versions WHERE account_id = ? AND luna_id = ?`, accountID, lunaID).Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return version, err
}

// storageNamePrefixEnd is the exclusive upper bound for all names beginning with prefix. The
// page prefix is validated to end in '.', whose next byte '/' bounds every allowed suffix.
func storageNamePrefixEnd(prefix string) string { return prefix[:len(prefix)-1] + "/" }

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

// SetSigningPublic registers a Luna's signing key from the request body (hex of its Ed25519 and ML-DSA public keys).
func (h StorageHandler) SetSigningPublic(w http.ResponseWriter, r *http.Request) {
	accountID, ok := storageAccount(w, r)
	if !ok {
		return
	}
	tx, err := h.DB.BeginTx(r.Context(), nil)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not check this Luna. Try again.")
		return
	}
	defer tx.Rollback()
	if err := database.LockStorageAccountWrite(tx, accountID); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not check this Luna. Try again.")
		return
	}
	lunaID := chi.URLParam(r, "id")
	if !storageLunaIDPattern.MatchString(lunaID) {
		JSONError(w, http.StatusBadRequest, "That Luna ID is not valid. Update Luna and try again.")
		return
	}
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 2*lunaSigPublicLen+64))
	if err != nil {
		JSONError(w, http.StatusBadRequest, "Could not read that signing key. Try again.")
		return
	}
	if !setSigningPublic(tx, w, accountID, lunaID, deviceIDFrom(r), string(body)) {
		return
	}
	if err := tx.Commit(); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not save that signing key. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h StorageHandler) Usage(w http.ResponseWriter, r *http.Request) {
	accountID, _, _, ok := storageScope(h.Deps, w, r)
	if !ok {
		return
	}
	JSON(w, http.StatusOK, map[string]any{
		"used_bytes":  storageUsed(h.DB, accountID),
		"quota_bytes": accountBackupCap(h.DB, accountID),
	})
}

func backupUnlocked(exec storageQueryExec, accountID string) bool {
	if accountID == "" {
		return false
	}
	var has int
	var status string
	err := exec.QueryRow(`SELECT has_card, billing_status FROM accounts WHERE id = ?`, accountID).Scan(&has, &status)
	return err == nil && billing.BackupsUnlocked(has == 1, status)
}

func accountBackupCap(exec storageQueryExec, accountID string) int64 {
	var quota sql.NullInt64
	_ = exec.QueryRow(`SELECT backup_quota_bytes FROM accounts WHERE id = ?`, accountID).Scan(&quota)
	if quota.Valid && quota.Int64 > 0 {
		return quota.Int64
	}
	if config.C.Backup.MaxAccountBytes > 0 {
		return config.C.Backup.MaxAccountBytes
	}
	return 2_000_000_000_000
}
