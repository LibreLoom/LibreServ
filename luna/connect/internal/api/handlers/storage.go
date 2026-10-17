package handlers

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

const (
	maxStoragePackBytes   = 64 << 20
	maxStorageRecordBytes = 1 << 20
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

// storageScope checks the device and the X-Luna-Id header, then returns the
// account and the Luna id that the call is scoped to.
func storageScope(w http.ResponseWriter, r *http.Request) (accountID, lunaID string, ok bool) {
	dev, found := DeviceFrom(r.Context())
	if !found || !dev.AccountID.Valid {
		JSONError(w, http.StatusForbidden, "Link this Luna at connect.luna.libreloom.org first.")
		return "", "", false
	}
	lunaID = strings.TrimSpace(r.Header.Get("X-Luna-Id"))
	if !storageLunaIDPattern.MatchString(lunaID) {
		JSONError(w, http.StatusBadRequest, "Luna did not say which Luna is asking. Update Luna and try again.")
		return "", "", false
	}
	return dev.AccountID.String, lunaID, true
}

// storageSlot is the directory-like key the blob store uses for one Luna.
// validStorageName accepts the documented pattern and rejects dot segments,
// so a name can never climb out of its folder.
func validStorageName(s string) bool {
	return storageNamePattern.MatchString(s) && s != "." && !strings.Contains(s, "..")
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
	accountID, lunaID, ok := storageScope(w, r)
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
	hasher := sha256.New()
	limited := http.MaxBytesReader(w, r.Body, limit)
	n, _, err := h.Store.Put(accountID, slot, rel, io.TeeReader(limited, hasher))
	if err != nil {
		_ = h.Store.Delete(accountID, slot, rel)
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			if remain < maxStoragePackBytes {
				storageFull(w)
				return
			}
			JSONError(w, http.StatusRequestEntityTooLarge, "That data is too large to store in cloud storage. The limit is 64 MB per piece.")
			return
		}
		if errors.Is(err, providers.ErrBackupNotConfigured) {
			JSONError(w, http.StatusServiceUnavailable, "Cloud storage is not ready yet. Contact support and we will finish setting it up.")
			return
		}
		JSONError(w, http.StatusBadRequest, "Cloud storage could not save that data. Check your connection and try again.")
		return
	}
	if hex.EncodeToString(hasher.Sum(nil)) != id {
		_ = h.Store.Delete(accountID, slot, rel)
		JSONError(w, http.StatusBadRequest, "The data did not match its ID. Try the upload again from Luna.")
		return
	}
	if _, err := h.DB.Exec(`INSERT INTO storage_packs (account_id, luna_id, id, scope, size, created_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(account_id, luna_id, id) DO NOTHING`, accountID, lunaID, id, scope, n, time.Now().Unix()); err != nil {
		_ = h.Store.Delete(accountID, slot, rel)
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not record that data. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true, "id": id, "size": n, "created": true})
}

func (h StorageHandler) GetPack(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, ok := storageScope(w, r)
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
	accountID, lunaID, ok := storageScope(w, r)
	if !ok {
		return
	}
	id := chi.URLParam(r, "id")
	if !storagePackIDPattern.MatchString(id) {
		JSONError(w, http.StatusNotFound, "That pack is not in cloud storage.")
		return
	}
	if _, err := h.DB.Exec(`DELETE FROM storage_packs WHERE account_id = ? AND luna_id = ? AND id = ?`,
		accountID, lunaID, id); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not delete that pack. Try again.")
		return
	}
	// A pack that is already gone still counts as deleted, so retries are safe.
	_ = h.Store.Delete(accountID, store.StorageSlot(lunaID), store.StoragePackPath(id))
	w.WriteHeader(http.StatusNoContent)
}

func (h StorageHandler) PutRecord(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, ok := storageScope(w, r)
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
	n, _, err := h.Store.Put(accountID, slot, rel, bytes.NewReader(data))
	if err != nil {
		_ = h.Store.Delete(accountID, slot, rel)
		if errors.Is(err, providers.ErrBackupNotConfigured) {
			JSONError(w, http.StatusServiceUnavailable, "Cloud storage is not ready yet. Contact support and we will finish setting it up.")
			return
		}
		JSONError(w, http.StatusBadRequest, "Cloud storage could not save that record. Check your connection and try again.")
		return
	}
	if _, err := h.DB.Exec(`INSERT INTO storage_records (account_id, luna_id, kind, name, bytes, updated_at)
VALUES (?, ?, ?, ?, ?, ?)
ON CONFLICT(account_id, luna_id, kind, name) DO UPDATE SET bytes = excluded.bytes, updated_at = excluded.updated_at`,
		accountID, lunaID, kind, name, n, time.Now().Unix()); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not record that save. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true, "bytes": n})
}

func (h StorageHandler) GetRecord(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, ok := storageScope(w, r)
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
	accountID, lunaID, ok := storageScope(w, r)
	if !ok {
		return
	}
	kind, name := chi.URLParam(r, "kind"), chi.URLParam(r, "name")
	if !validStorageName(kind) || !validStorageName(name) {
		JSONError(w, http.StatusBadRequest, "That record name is not valid. Use only lowercase letters, numbers, dots, dashes and underscores.")
		return
	}
	if _, err := h.DB.Exec(`DELETE FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ? AND name = ?`,
		accountID, lunaID, kind, name); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not delete that record. Try again.")
		return
	}
	_ = h.Store.Delete(accountID, store.StorageSlot(lunaID), store.StorageRecordPath(kind, name))
	w.WriteHeader(http.StatusNoContent)
}

func (h StorageHandler) ListRecords(w http.ResponseWriter, r *http.Request) {
	accountID, lunaID, ok := storageScope(w, r)
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

func (h StorageHandler) Usage(w http.ResponseWriter, r *http.Request) {
	accountID, _, ok := storageScope(w, r)
	if !ok {
		return
	}
	JSON(w, http.StatusOK, map[string]any{
		"used_bytes":  storageUsed(h.Deps, accountID),
		"quota_bytes": accountBackupCap(h.Deps, accountID),
	})
}
