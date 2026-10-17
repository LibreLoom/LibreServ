package handlers

import (
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/billing"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

// CloudReadHandler serves the account's own cloud backup data to its browser. Everything it
// returns is encrypted or signed by Luna; the browser checks it, Connect never opens it.
type CloudReadHandler struct{ Deps }

// readScope is what a caller may read on one Luna. Kind "" is the account owner (everything);
// "user" and "backup" are share-link scopes (task G4).
type readScope struct {
	AccountID, LunaID string
	Kind, Value       string
}

// browserKinds are the record kinds a browser may read.
var browserKinds = map[string]bool{"snapshots": true, "keys": true, "recipients": true, "self": true}

type storedRecord struct {
	Name string
	Data []byte
}

// snapshotRecordJSON is the part of a signed snapshot record the filters read.
type snapshotRecordJSON struct {
	Record struct {
		ProtectionID string `json:"protection_id"`
		TreePackID   string `json:"tree_pack_id"`
	} `json:"record"`
}

// cloudAccountID returns the signed-in household account. It writes the error when there is none.
func cloudAccountID(w http.ResponseWriter, r *http.Request) (string, bool) {
	acct, ok := AccountFrom(r.Context())
	if !ok || acct.ID == "" {
		JSONError(w, http.StatusUnauthorized, "Sign in again to see your cloud backups.")
		return "", false
	}
	return acct.ID, true
}

// cloudLunaOnAccount reports whether a Luna has a row on the account. Any failure counts as no.
func cloudLunaOnAccount(d Deps, accountID, lunaID string) bool {
	if !storageLunaIDPattern.MatchString(lunaID) {
		return false
	}
	var one int
	err := d.DB.QueryRow(`SELECT 1 FROM luna_ids WHERE account_id = ? AND luna_id = ?`,
		accountID, lunaID).Scan(&one)
	return err == nil
}

// ListLunas answers the Lunas on the signed-in account, with the name of the device each one is on.
func (h CloudReadHandler) ListLunas(w http.ResponseWriter, r *http.Request) {
	accountID, ok := cloudAccountID(w, r)
	if !ok {
		return
	}
	rows, err := h.DB.Query(`SELECT l.luna_id, COALESCE(d.name, ''),
CASE WHEN d.account_id = l.account_id THEN 1 ELSE 0 END
FROM luna_ids l LEFT JOIN devices d ON d.id = l.device_id
WHERE l.account_id = ? ORDER BY l.created_at`, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not list your Lunas. Try again.")
		return
	}
	defer rows.Close()
	type lunaItem struct {
		LunaID string `json:"luna_id"`
		Name   string `json:"name"`
		Linked bool   `json:"linked"`
	}
	out := make([]lunaItem, 0)
	for rows.Next() {
		var it lunaItem
		var linked int
		if err := rows.Scan(&it.LunaID, &it.Name, &linked); err != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not list your Lunas. Try again.")
			return
		}
		it.Linked = linked == 1
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not list your Lunas. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"lunas": out})
}

// ListRecords answers one kind of record for a Luna on the signed-in account.
func (h CloudReadHandler) ListRecords(w http.ResponseWriter, r *http.Request) {
	accountID, ok := cloudAccountID(w, r)
	if !ok {
		return
	}
	lunaID := chi.URLParam(r, "lunaID")
	if !cloudLunaOnAccount(h.Deps, accountID, lunaID) {
		JSONError(w, http.StatusNotFound, "That Luna has no cloud backups on this account.")
		return
	}
	writeRecords(h.Deps, w, readScope{AccountID: accountID, LunaID: lunaID}, chi.URLParam(r, "kind"))
}

// GetPack streams one pack of a Luna on the signed-in account.
func (h CloudReadHandler) GetPack(w http.ResponseWriter, r *http.Request) {
	accountID, ok := cloudAccountID(w, r)
	if !ok {
		return
	}
	lunaID := chi.URLParam(r, "lunaID")
	if !cloudLunaOnAccount(h.Deps, accountID, lunaID) {
		JSONError(w, http.StatusNotFound, "That Luna has no cloud backups on this account.")
		return
	}
	writePack(h.Deps, w, readScope{AccountID: accountID, LunaID: lunaID}, chi.URLParam(r, "id"))
}

// recordNames lists the names of one kind of record for the scope's Luna, in name order.
func recordNames(d Deps, s readScope, kind string) ([]string, error) {
	rows, err := d.DB.Query(`SELECT name FROM storage_records WHERE account_id = ? AND luna_id = ? AND kind = ? ORDER BY name`,
		s.AccountID, s.LunaID, kind)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var names []string
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		names = append(names, name)
	}
	return names, rows.Err()
}

// loadRecords reads every record of one kind for the scope's Luna, in name order. It applies
// no filter.
func loadRecords(d Deps, s readScope, kind string) ([]storedRecord, error) {
	names, err := recordNames(d, s, kind)
	if err != nil {
		return nil, err
	}
	out := make([]storedRecord, 0, len(names))
	for _, name := range names {
		rc, err := d.Store.Get(s.AccountID, store.StorageSlot(s.LunaID), store.StorageRecordPath(kind, name))
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(io.LimitReader(rc, maxStorageRecordBytes+1))
		rc.Close()
		if err != nil {
			return nil, err
		}
		if len(data) > maxStorageRecordBytes {
			return nil, fmt.Errorf("record %s/%s is larger than %d bytes", kind, name, maxStorageRecordBytes)
		}
		out = append(out, storedRecord{Name: name, Data: data})
	}
	return out, nil
}

// parseKeyName splits a key name "<prot>.<version>.<part>". ok is false for any other shape.
func parseKeyName(name string) (prot string, version int, part string, ok bool) {
	parts := strings.SplitN(name, ".", 3)
	if len(parts) != 3 {
		return "", 0, "", false
	}
	version, err := strconv.Atoi(parts[1])
	if err != nil {
		return "", 0, "", false
	}
	return parts[0], version, parts[2], true
}

// filterRecords keeps the records the scope may see. keyNames are all "keys" record names
// on this Luna (used to decide which backups a user scope reaches).
func filterRecords(s readScope, kind string, recs []storedRecord, keyNames []string) []storedRecord {
	allowed := allowedProtections(s, keyNames)
	if allowed == nil {
		return recs
	}
	out := make([]storedRecord, 0, len(recs))
	for _, rec := range recs {
		keep := false
		switch kind {
		case "keys":
			prot, _, _, ok := parseKeyName(rec.Name)
			keep = ok && allowed[prot]
		case "recipients":
			prot, _, _ := strings.Cut(rec.Name, ".")
			keep = allowed[prot]
		case "snapshots":
			var snap snapshotRecordJSON
			if err := json.Unmarshal(rec.Data, &snap); err == nil {
				keep = allowed[snap.Record.ProtectionID]
			}
		default:
			// self records are sealed with a key only the person's phrase makes, and the
			// browser needs its own one even when its user id changed.
			keep = true
		}
		if keep {
			out = append(out, rec)
		}
	}
	return out
}

// allowedProtections returns the backup (protection) ids a scope reaches; nil means all.
func allowedProtections(s readScope, keyNames []string) map[string]bool {
	switch s.Kind {
	case "":
		return nil
	case "backup":
		return map[string]bool{s.Value: true}
	case "user":
		// A user reaches a backup only with a copy of its latest key version.
		allowed := map[string]bool{}
		latest := map[string]int{}
		for _, name := range keyNames {
			prot, version, _, ok := parseKeyName(name)
			if ok && version > latest[prot] {
				latest[prot] = version
			}
		}
		for _, name := range keyNames {
			prot, version, part, ok := parseKeyName(name)
			if ok && version == latest[prot] && part == s.Value {
				allowed[prot] = true
			}
		}
		return allowed
	}
	return map[string]bool{}
}

// packAllowed reports whether a pack may be served to the scope (always true for Kind "").
// Data packs carry the same scope tag as their snapshot's tree pack, because both come from
// the backup's dedup key, so a pack is allowed when its tag matches a tree pack of an allowed snapshot.
func packAllowed(d Deps, s readScope, packID string) (bool, error) {
	if s.Kind == "" {
		return true, nil
	}
	snaps, err := loadRecords(d, s, "snapshots")
	if err != nil {
		return false, err
	}
	keyNames, err := recordNames(d, s, "keys")
	if err != nil {
		return false, err
	}
	snaps = filterRecords(s, "snapshots", snaps, keyNames)
	scopes := map[string]bool{}
	for _, snap := range snaps {
		var parsed snapshotRecordJSON
		if err := json.Unmarshal(snap.Data, &parsed); err != nil || parsed.Record.TreePackID == "" {
			continue
		}
		var scope string
		err := d.DB.QueryRow(`SELECT scope FROM storage_packs WHERE account_id = ? AND luna_id = ? AND id = ?`,
			s.AccountID, s.LunaID, parsed.Record.TreePackID).Scan(&scope)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return false, err
		}
		if scope != "" {
			scopes[scope] = true
		}
	}
	var scope string
	err = d.DB.QueryRow(`SELECT scope FROM storage_packs WHERE account_id = ? AND luna_id = ? AND id = ?`,
		s.AccountID, s.LunaID, packID).Scan(&scope)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return scope != "" && scopes[scope], nil
}

// writeRecords and writePack do the HTTP part for both the account and share routes.
func writeRecords(d Deps, w http.ResponseWriter, s readScope, kind string) {
	if !browserKinds[kind] {
		JSONError(w, http.StatusNotFound, "That kind of backup record is not available.")
		return
	}
	const readErr = "Cloud storage could not read this backup. Try again."
	recs, err := loadRecords(d, s, kind)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, readErr)
		return
	}
	var keyNames []string
	if s.Kind != "" {
		keyNames, err = recordNames(d, s, "keys")
		if err != nil {
			JSONError(w, http.StatusInternalServerError, readErr)
			return
		}
	}
	recs = filterRecords(s, kind, recs, keyNames)

	type recordItem struct {
		Name string `json:"name"`
		Data string `json:"data"`
	}
	out := make([]recordItem, 0, len(recs))
	var total int64
	for _, rec := range recs {
		total += int64(len(rec.Data))
		out = append(out, recordItem{Name: rec.Name, Data: base64.StdEncoding.EncodeToString(rec.Data)})
	}
	if total > 0 {
		billing.RecordEgress(d.DB, s.AccountID, total)
	}
	JSON(w, http.StatusOK, map[string]any{"records": out})
}

// writePack streams one pack to the scope. Every refusal gets the same answer, so a caller
// cannot tell a pack that is missing from one it may not see.
func writePack(d Deps, w http.ResponseWriter, s readScope, packID string) {
	notFound := func() {
		JSONError(w, http.StatusNotFound, "That backup file is not in cloud storage.")
	}
	if !storagePackIDPattern.MatchString(packID) {
		notFound()
		return
	}
	var one int
	if err := d.DB.QueryRow(`SELECT 1 FROM storage_packs WHERE account_id = ? AND luna_id = ? AND id = ?`,
		s.AccountID, s.LunaID, packID).Scan(&one); err != nil {
		notFound()
		return
	}
	allowed, err := packAllowed(d, s, packID)
	if err != nil || !allowed {
		notFound()
		return
	}
	rc, err := d.Store.Get(s.AccountID, store.StorageSlot(s.LunaID), store.StoragePackPath(packID))
	if err != nil {
		notFound()
		return
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	n, err := io.Copy(w, rc)
	if err == nil && n > 0 {
		billing.RecordEgress(d.DB, s.AccountID, n)
	}
}
