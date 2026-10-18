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
	"sync"
	"time"

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
var browserKinds = map[string]bool{"snapshots": true, "keys": true, "recipients": true, "self": true, "pscopes": true, "psnapshots": true}

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
CASE WHEN d.id IS NULL THEN 0 ELSE 1 END, l.purge_after
FROM luna_ids l LEFT JOIN devices d ON d.id = l.device_id AND d.account_id = l.account_id
WHERE l.account_id = ? ORDER BY l.created_at`, accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not list your Lunas. Try again.")
		return
	}
	defer rows.Close()
	type lunaItem struct {
		LunaID     string `json:"luna_id"`
		Name       string `json:"name"`
		Linked     bool   `json:"linked"`
		PurgeAfter int64  `json:"purge_after"`
	}
	out := make([]lunaItem, 0)
	for rows.Next() {
		var it lunaItem
		var linked int
		if err := rows.Scan(&it.LunaID, &it.Name, &linked, &it.PurgeAfter); err != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not list your Lunas. Try again.")
			return
		}
		it.Linked = linked == 1
		// -1 means a purge is running (or stopped mid-run): the browser only needs to know it is not scheduled.
		if it.PurgeAfter < 0 {
			it.PurgeAfter = 0
		}
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
	writeRecords(h.Deps, w, readScope{AccountID: accountID, LunaID: lunaID}, chi.URLParam(r, "kind"), "", r.Header.Get(privateTokenHeader))
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
	writePack(h.Deps, w, readScope{AccountID: accountID, LunaID: lunaID}, chi.URLParam(r, "id"), "", r.Header.Get(privateTokenHeader))
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

// packScopeCacheTTL is how long a share link keeps its allowed pack scopes before they are rebuilt.
const packScopeCacheTTL = 60 * time.Second

// cachedPackScopes is one share link's allowed pack scopes and when they were built.
type cachedPackScopes struct {
	scopes map[string]bool
	at     time.Time
}

// packScopeCache holds cachedPackScopes per share link id. resolveShare still refuses a revoked
// or expired link on every request; the cache only spares rereading the snapshots.
var packScopeCache sync.Map

// packAllowed reports whether a pack may be served to the scope (always true for Kind "").
// Data packs carry the same scope tag as their snapshot's tree pack, because both come from
// the backup's dedup key, so a pack is allowed when its tag matches a tree pack of an allowed snapshot.
// linkID is the share link's id; "" skips the cache.
func packAllowed(d Deps, s readScope, linkID, packID string) (bool, error) {
	if s.Kind == "" {
		return true, nil
	}
	scopes, err := allowedPackScopes(d, s, linkID, time.Now())
	if err != nil {
		return false, err
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

// allowedPackScopes returns the pack scope tags a share scope may read, from a cache that lives
// packScopeCacheTTL for each link.
func allowedPackScopes(d Deps, s readScope, linkID string, now time.Time) (map[string]bool, error) {
	if linkID == "" {
		return loadPackScopes(d, s)
	}
	if v, ok := packScopeCache.Load(linkID); ok {
		if c := v.(cachedPackScopes); now.Sub(c.at) < packScopeCacheTTL {
			return c.scopes, nil
		}
	}
	scopes, err := loadPackScopes(d, s)
	if err != nil {
		return nil, err
	}
	packScopeCache.Store(linkID, cachedPackScopes{scopes: scopes, at: now})
	return scopes, nil
}

// loadPackScopes reads the snapshots and key names the scope may see and returns the scope tags
// of their tree packs.
func loadPackScopes(d Deps, s readScope) (map[string]bool, error) {
	snaps, err := loadRecords(d, s, "snapshots")
	if err != nil {
		return nil, err
	}
	keyNames, err := recordNames(d, s, "keys")
	if err != nil {
		return nil, err
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
			return nil, err
		}
		if scope != "" {
			scopes[scope] = true
		}
	}
	return scopes, nil
}

// privateTokenHeader carries the private session token that opens a private scope.
const privateTokenHeader = "X-Private-Token"

// privatePackReadErr is the 500 answer when a pack's private scope cannot be checked.
const privatePackReadErr = "Cloud storage could not read this backup. Try again."

// writeRecords and writePack do the HTTP part for both the account and share routes.
// linkID is the share link, or "" for the account owner. token is the X-Private-Token header.
func writeRecords(d Deps, w http.ResponseWriter, s readScope, kind, linkID, token string) {
	if !browserKinds[kind] {
		JSONError(w, http.StatusNotFound, "That kind of backup record is not available.")
		return
	}
	const readErr = "Cloud storage could not read this backup. Try again."
	prefix := ""
	if kind == "psnapshots" {
		scope, err := privateSessionScope(d, s, linkID, token, time.Now())
		if err != nil {
			JSONError(w, http.StatusInternalServerError, readErr)
			return
		}
		if scope == "" {
			JSONError(w, http.StatusForbidden, privateTokenMessage)
			return
		}
		prefix = scope + "."
	}
	recs, err := loadRecords(d, s, kind)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, readErr)
		return
	}
	if kind == "pscopes" {
		recs, err = filterPrivateScopes(d, s, recs)
		if err != nil {
			JSONError(w, http.StatusInternalServerError, readErr)
			return
		}
	}
	if prefix != "" {
		recs = keepWithPrefix(recs, prefix)
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

// filterPrivateScopes keeps the pscopes records the scope may see. The account owner sees all of
// them, a user share link sees only the record for its own user, and every other link sees none.
func filterPrivateScopes(d Deps, s readScope, recs []storedRecord) ([]storedRecord, error) {
	if s.Kind == "" {
		return recs, nil
	}
	out := []storedRecord{}
	if s.Kind != "user" {
		return out, nil
	}
	_, signingHex, found, err := lookupLuna(d, s.AccountID, s.LunaID)
	if err != nil {
		return nil, err
	}
	if !found {
		return out, nil
	}
	for _, rec := range recs {
		parsed, ok := parseScopeRecord(rec.Data, signingHex)
		if ok && scopePart(parsed.UserID) == s.Value {
			out = append(out, rec)
		}
	}
	return out, nil
}

// keepWithPrefix keeps the records whose name starts with prefix.
func keepWithPrefix(recs []storedRecord, prefix string) []storedRecord {
	out := make([]storedRecord, 0, len(recs))
	for _, rec := range recs {
		if strings.HasPrefix(rec.Name, prefix) {
			out = append(out, rec)
		}
	}
	return out
}

// writePack streams one pack to the scope and returns the bytes it wrote, even when the copy
// stops early. Every refusal gets the same answer, so a caller cannot tell a pack that is missing
// from one it may not see. A pack in a private scope needs a session token for that scope: the
// account owner gets a 403 without one, and a share link gets the same 404 as any other refusal.
// linkID is the share link, or "" for the account owner.
func writePack(d Deps, w http.ResponseWriter, s readScope, packID, linkID, token string) int64 {
	notFound := func() {
		JSONError(w, http.StatusNotFound, "That backup file is not in cloud storage.")
	}
	if !storagePackIDPattern.MatchString(packID) {
		notFound()
		return 0
	}
	var packScope string
	if err := d.DB.QueryRow(`SELECT scope FROM storage_packs WHERE account_id = ? AND luna_id = ? AND id = ?`,
		s.AccountID, s.LunaID, packID).Scan(&packScope); err != nil {
		notFound()
		return 0
	}
	_, isPrivate, err := loadScopeRecord(d, s, packScope)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, privatePackReadErr)
		return 0
	}
	if isPrivate {
		sess, err := privateSessionScope(d, s, linkID, token, time.Now())
		if err != nil {
			JSONError(w, http.StatusInternalServerError, privatePackReadErr)
			return 0
		}
		if sess != packScope {
			if s.Kind == "" {
				JSONError(w, http.StatusForbidden, privateTokenMessage)
			} else {
				notFound()
			}
			return 0
		}
	} else {
		allowed, err := packAllowed(d, s, linkID, packID)
		if err != nil || !allowed {
			notFound()
			return 0
		}
	}
	rc, err := d.Store.Get(s.AccountID, store.StorageSlot(s.LunaID), store.StoragePackPath(packID))
	if err != nil {
		notFound()
		return 0
	}
	defer rc.Close()
	w.Header().Set("Content-Type", "application/octet-stream")
	n, _ := io.Copy(w, rc)
	if n > 0 {
		billing.RecordEgress(d.DB, s.AccountID, n)
	}
	return n
}
