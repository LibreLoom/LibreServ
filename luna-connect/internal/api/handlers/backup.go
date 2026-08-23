package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
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
	return err == nil && has == 1 && (status == "active" || status == "dev")
}

func (h BackupHandler) PutObject(w http.ResponseWriter, r *http.Request) {
	dev, ok := DeviceFrom(r.Context())
	if !ok || !dev.AccountID.Valid {
		JSONError(w, http.StatusForbidden, "Pair this Luna at connect.luna.libreloom.org and add a payment card first.")
		return
	}
	if !backupUnlocked(h.Deps, dev.AccountID.String) {
		JSONError(w, http.StatusPaymentRequired, "Add a payment card at connect.luna.libreloom.org so we can store a spare copy. It costs $7 per terabyte each month.")
		return
	}
	rel := objectPath(r)
	if rel == "" {
		JSONError(w, http.StatusBadRequest, "Missing file path.")
		return
	}
	hashHdr := r.Header.Get("X-Content-Hash")
	n, err := h.Store.Put(dev.AccountID.String, dev.ID, rel, r.Body)
	if err != nil {
		JSONError(w, http.StatusBadRequest, "Could not save that file.")
		return
	}
	if hashHdr == "" {
		hashHdr = "size:" + itoa(int(n))
	}
	id := security.NewID("obj")
	_, _ = h.DB.Exec(`INSERT INTO backup_objects (id, account_id, device_id, relative_path, size, content_hash, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(account_id, device_id, relative_path) DO UPDATE SET size=excluded.size, content_hash=excluded.content_hash, updated_at=excluded.updated_at`,
		id, dev.AccountID.String, dev.ID, rel, n, hashHdr, time.Now().Unix())
	JSON(w, http.StatusOK, map[string]any{"ok": true, "size": n})
}

func (h BackupHandler) DeleteObject(w http.ResponseWriter, r *http.Request) {
	dev, ok := DeviceFrom(r.Context())
	if !ok || !dev.AccountID.Valid {
		JSONError(w, http.StatusForbidden, "Pair this Luna first.")
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
	rows, err := h.DB.Query(`SELECT device_id, relative_path, size, content_hash, updated_at FROM backup_objects WHERE account_id = ? ORDER BY relative_path`, acct.ID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Could not list spare copies.")
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
		"objects": list,
		"note":    "This is the latest copy we have, not a history of old versions.",
	})
}

func (h BackupHandler) Download(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	deviceID := r.URL.Query().Get("device_id")
	rel := r.URL.Query().Get("path")
	rc, err := h.Store.Get(acct.ID, deviceID, rel)
	if err != nil {
		JSONError(w, http.StatusNotFound, "That file is not in the spare copy.")
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+rel+"\"")
	_, _ = io.Copy(w, rc)
}

func (h BackupHandler) DeleteAccountObject(w http.ResponseWriter, r *http.Request) {
	acct, ok := AccountFrom(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Sign in to continue.")
		return
	}
	deviceID := r.URL.Query().Get("device_id")
	rel := r.URL.Query().Get("path")
	_ = h.Store.Delete(acct.ID, deviceID, rel)
	_, _ = h.DB.Exec(`DELETE FROM backup_objects WHERE account_id = ? AND device_id = ? AND relative_path = ?`,
		acct.ID, deviceID, rel)
	JSON(w, http.StatusOK, map[string]any{"ok": true})
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
