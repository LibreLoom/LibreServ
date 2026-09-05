package handlers

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/providers"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

type BackupHandler struct {
	Deps
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

// ownedBackupObject authorizes account reads after transfer: the device row
// may be gone, but the copies still belong to this account.
func ownedBackupObject(h Deps, accountID, deviceID, rel string) (string, bool) {
	if accountID == "" || !opaquePathID(deviceID) || strings.TrimSpace(rel) == "" {
		return "", false
	}
	var id string
	err := h.DB.QueryRow(`SELECT device_id FROM backup_objects WHERE account_id = ? AND device_id = ? AND relative_path = ?`,
		accountID, deviceID, rel).Scan(&id)
	return id, err == nil && id != ""
}

func opaquePathID(id string) bool {
	if id == "" || strings.ContainsRune(id, 0) {
		return false
	}
	return !strings.ContainsAny(id, `/\`) && !strings.Contains(id, "..")
}

func (h BackupHandler) PutObject(w http.ResponseWriter, r *http.Request) {
	dev, ok := DeviceFrom(r.Context())
	if !ok || !dev.AccountID.Valid {
		JSONError(w, http.StatusForbidden, "Link this Luna at connect.luna.libreloom.org and add a payment card first.")
		return
	}
	if !backupUnlocked(h.Deps, dev.AccountID.String) {
		JSONError(w, http.StatusPaymentRequired, "Add a payment card at connect.luna.libreloom.org so we can store a cloud backup. It costs $8 per terabyte each month.")
		return
	}
	rel := objectPath(r)
	if rel == "" {
		JSONError(w, http.StatusBadRequest, "Cloud backup did not receive a file path. Try the backup again from Luna.")
		return
	}
	maxObj := config.C.Backup.MaxObjectBytes
	if maxObj <= 0 {
		maxObj = 1 << 30
	}
	capBytes := accountBackupCap(h.Deps, dev.AccountID.String)
	var used int64
	_ = h.DB.QueryRow(`SELECT COALESCE(SUM(size),0) FROM backup_objects WHERE account_id = ?`, dev.AccountID.String).Scan(&used)
	remain := capBytes - used
	if remain <= 0 {
		JSONError(w, http.StatusRequestEntityTooLarge, "Cloud backup for this account is full. Remove some files, then try again.")
		return
	}
	if remain < maxObj {
		maxObj = remain
	}
	limited := http.MaxBytesReader(w, r.Body, maxObj)
	hasher := sha256.New()
	n, backend, err := h.Store.Put(dev.AccountID.String, dev.ID, rel, io.TeeReader(limited, hasher))
	if err != nil {
		deletePutTarget(h.Store, backend, dev.AccountID.String, dev.ID, rel)
		var maxErr *http.MaxBytesError
		if errors.As(err, &maxErr) {
			JSONError(w, http.StatusRequestEntityTooLarge, "That file is too large to store in cloud backup.")
			return
		}
		if errors.Is(err, providers.ErrBackupNotConfigured) {
			JSONError(w, http.StatusServiceUnavailable, "Cloud backup storage is not ready yet. Contact support and we will finish setting it up.")
			return
		}
		JSONError(w, http.StatusBadRequest, "Cloud backup could not save that file. Check your connection and try again.")
		return
	}
	sum := hex.EncodeToString(hasher.Sum(nil))
	if hdr := strings.TrimSpace(r.Header.Get("X-Content-Hash")); hdr != "" && !strings.EqualFold(hdr, sum) {
		deletePutTarget(h.Store, backend, dev.AccountID.String, dev.ID, rel)
		JSONError(w, http.StatusBadRequest, "The file did not match what Luna said it sent. Try the copy again.")
		return
	}
	if backend == "" {
		backend = store.BackendLocal
	}
	id := security.NewID("obj")
	_, _ = h.DB.Exec(`INSERT INTO backup_objects (id, account_id, device_id, relative_path, size, content_hash, storage_backend, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(account_id, device_id, relative_path) DO UPDATE SET size=excluded.size, content_hash=excluded.content_hash, storage_backend=excluded.storage_backend, updated_at=excluded.updated_at`,
		id, dev.AccountID.String, dev.ID, rel, n, sum, backend, time.Now().Unix())
	JSON(w, http.StatusOK, map[string]any{"ok": true, "size": n, "content_hash": sum})
}

// deletePutTarget removes a just-written object from the backend Put used, without
// touching an older copy that may still be recorded on another backend.
func deletePutTarget(st store.Store, backend, accountID, deviceID, rel string) {
	if a, ok := st.(*store.Auto); ok && backend != "" {
		_ = a.DeleteBackend(backend, accountID, deviceID, rel)
		return
	}
	_ = st.Delete(accountID, deviceID, rel)
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

func (h BackupHandler) DeleteObject(w http.ResponseWriter, r *http.Request) {
	dev, ok := DeviceFrom(r.Context())
	if !ok || !dev.AccountID.Valid {
		JSONError(w, http.StatusForbidden, "Link this Luna to your account first.")
		return
	}
	rel := objectPath(r)
	_ = h.Store.Delete(dev.AccountID.String, dev.ID, rel)
	_, _ = h.DB.Exec(`DELETE FROM backup_objects WHERE account_id = ? AND device_id = ? AND relative_path = ?`,
		dev.AccountID.String, dev.ID, rel)
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (h BackupHandler) List(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	limit, offset := parseListPage(r)
	var total int
	_ = h.DB.QueryRow(`SELECT COUNT(*) FROM backup_objects WHERE account_id = ?`, acct.ID).Scan(&total)
	totalPtr := total

	rows, err := h.DB.Query(`SELECT device_id, relative_path, size, content_hash, updated_at FROM backup_objects WHERE account_id = ? ORDER BY relative_path LIMIT ? OFFSET ?`, acct.ID, limit, offset)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not list cloud backups.")
		return
	}
	defer rows.Close()
	type obj struct {
		DeviceID     string `json:"device_id"`
		RelativePath string `json:"relative_path"`
		Size         int64  `json:"size"`
		Hash         string `json:"content_hash"`
		UpdatedAt    int64  `json:"updated_at"`
	}
	list := []obj{}
	for rows.Next() {
		var o obj
		_ = rows.Scan(&o.DeviceID, &o.RelativePath, &o.Size, &o.Hash, &o.UpdatedAt)
		list = append(list, o)
	}
	JSON(w, http.StatusOK, map[string]any{
		"objects":    list,
		"pagination": buildListPage(limit, offset, len(list), &totalPtr),
		"note":       "This is the latest copy we have, not a history of old versions.",
	})
}

func (h BackupHandler) Download(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	deviceID, rel := backupObjectRef(r)
	owned, ok := ownedBackupObject(h.Deps, acct.ID, deviceID, rel)
	if !ok {
		JSONError(w, http.StatusNotFound, "That file is not in cloud backup.")
		return
	}
	rc, err := h.Store.Get(acct.ID, owned, rel)
	if err != nil {
		JSONError(w, http.StatusNotFound, "That file is not in cloud backup.")
		return
	}
	defer rc.Close()
	name := filepath.Base(rel)
	if name == "" || name == "." || name == "/" {
		name = "download"
	}
	cd := mime.FormatMediaType("attachment", map[string]string{"filename": name})
	w.Header().Set("Content-Type", "application/octet-stream")
	if cd != "" {
		w.Header().Set("Content-Disposition", cd)
	}
	n, err := io.Copy(w, rc)
	if err == nil && n > 0 {
		billing.RecordEgress(h.DB, acct.ID, n)
	}
}

func (h BackupHandler) DeleteAccountObject(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	deviceID, rel := backupObjectRef(r)
	owned, ok := ownedBackupObject(h.Deps, acct.ID, deviceID, rel)
	if !ok {
		JSONError(w, http.StatusNotFound, "That file is not in cloud backup.")
		return
	}
	_ = h.Store.Delete(acct.ID, owned, rel)
	_, _ = h.DB.Exec(`DELETE FROM backup_objects WHERE account_id = ? AND device_id = ? AND relative_path = ?`,
		acct.ID, owned, rel)
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

func backupObjectRef(r *http.Request) (deviceID, rel string) {
	deviceID = strings.TrimSpace(r.URL.Query().Get("device_id"))
	rel = strings.TrimSpace(r.URL.Query().Get("path"))
	if r.Method == http.MethodPost || r.Method == http.MethodDelete {
		var req struct {
			DeviceID string `json:"device_id"`
			Path     string `json:"path"`
		}
		_ = json.NewDecoder(r.Body).Decode(&req)
		if strings.TrimSpace(req.DeviceID) != "" {
			deviceID = strings.TrimSpace(req.DeviceID)
		}
		if strings.TrimSpace(req.Path) != "" {
			rel = strings.TrimSpace(req.Path)
		}
	}
	return deviceID, rel
}

func objectPath(r *http.Request) string {
	rel := strings.TrimPrefix(chi.URLParam(r, "*"), "/")
	if rel == "" {
		if i := strings.Index(r.URL.Path, "/backup/objects/"); i >= 0 {
			rel = strings.TrimPrefix(r.URL.Path[i+len("/backup/objects/"):], "/")
		}
	}
	return rel
}

func ContentHash(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}
