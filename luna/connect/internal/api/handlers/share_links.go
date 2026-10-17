package handlers

import (
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

// Share links let a household Admin send one person's backups, or one backup, to whoever holds
// that person's recovery phrase. The link page shows only that scope, and the phrase is typed in
// the browser. A link alone opens nothing: it reaches only data Luna encrypted or signed.
//
// The token is 32 random bytes, shown once on create. Only its sha256 is stored. The web app puts
// the token in the URL fragment, so it never reaches server logs or a Referer, and it sends it in
// the X-Share-Token header. A link lives shareLinkTTL, and it is dead once revoked or expired.
// Unknown, expired and revoked links all get the same 404, so nobody can probe which tokens exist.

const (
	shareLinkTTL         = 7 * 24 * time.Hour
	maxActiveShareLinks  = 20
	shareTokenHeader     = "X-Share-Token"
	shareGoneMessage     = "This link has expired or was turned off. Ask the person who sent it for a new one."
	shareReadErrMessage  = "Cloud storage could not open this link. Try again."
	shareScopeMessage    = "Choose one person's backups or one backup to share."
	shareNoLunaMessage   = "That Luna has no cloud backups on this account."
	shareLimitMessage    = "You have 20 active backup links. Turn one off before making another."
	shareAlreadyOff      = "That link is already off."
	shareCreateBodyLimit = 4096
)

var (
	shareUserValuePattern   = regexp.MustCompile(`^[0-9a-f]{32}$`)
	shareBackupValuePattern = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)
)

// ShareLinkHandler makes, lists and turns off share links, and serves what a link may read.
type ShareLinkHandler struct{ Deps }

// newShareToken returns 32 random bytes as 43 URL-safe characters.
func newShareToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// writeShareGone writes the one answer for every link that cannot be used.
func writeShareGone(w http.ResponseWriter) {
	JSONError(w, http.StatusNotFound, shareGoneMessage)
}

// resolveShare reads X-Share-Token and returns the live link's scope and id. When the link is
// unknown, expired or revoked, it writes the 404 and returns false.
func resolveShare(d Deps, w http.ResponseWriter, r *http.Request, now time.Time) (readScope, string, bool) {
	token := r.Header.Get(shareTokenHeader)
	if token == "" || len(token) > 64 {
		writeShareGone(w)
		return readScope{}, "", false
	}
	var id string
	var s readScope
	err := d.DB.QueryRow(`SELECT id, account_id, luna_id, scope_kind, scope_value FROM share_links
WHERE token_hash = ? AND revoked_at = 0 AND expires_at > ?`,
		security.HashToken(token), now.Unix()).Scan(&id, &s.AccountID, &s.LunaID, &s.Kind, &s.Value)
	if errors.Is(err, sql.ErrNoRows) {
		writeShareGone(w)
		return readScope{}, "", false
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, shareReadErrMessage)
		return readScope{}, "", false
	}
	return s, id, true
}

// Create makes a share link for one user's backups or one backup on a Luna of the signed-in account.
func (h ShareLinkHandler) Create(w http.ResponseWriter, r *http.Request) {
	accountID, ok := cloudAccountID(w, r)
	if !ok {
		return
	}
	var req struct {
		LunaID     string `json:"luna_id"`
		ScopeKind  string `json:"scope_kind"`
		ScopeValue string `json:"scope_value"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, shareCreateBodyLimit)).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, shareScopeMessage)
		return
	}
	if !cloudLunaOnAccount(h.Deps, accountID, req.LunaID) {
		JSONError(w, http.StatusNotFound, shareNoLunaMessage)
		return
	}
	valid := false
	switch req.ScopeKind {
	case "user":
		valid = shareUserValuePattern.MatchString(req.ScopeValue)
	case "backup":
		valid = shareBackupValuePattern.MatchString(req.ScopeValue)
	}
	if !valid {
		JSONError(w, http.StatusBadRequest, shareScopeMessage)
		return
	}

	now := time.Now()
	var active int
	if err := h.DB.QueryRow(`SELECT COUNT(*) FROM share_links
WHERE account_id = ? AND revoked_at = 0 AND expires_at > ?`, accountID, now.Unix()).Scan(&active); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not make a link. Try again.")
		return
	}
	if active >= maxActiveShareLinks {
		JSONError(w, http.StatusConflict, shareLimitMessage)
		return
	}

	token, err := newShareToken()
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not make a link. Try again.")
		return
	}
	id := security.NewID("share")
	expiresAt := now.Add(shareLinkTTL).Unix()
	if _, err := h.DB.Exec(`INSERT INTO share_links (id, account_id, luna_id, token_hash, scope_kind, scope_value, created_at, expires_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, accountID, req.LunaID, security.HashToken(token),
		req.ScopeKind, req.ScopeValue, now.Unix(), expiresAt); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not make a link. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"id": id, "token": token, "expires_at": expiresAt})
}

// List answers the signed-in account's active share links, newest first.
func (h ShareLinkHandler) List(w http.ResponseWriter, r *http.Request) {
	accountID, ok := cloudAccountID(w, r)
	if !ok {
		return
	}
	rows, err := h.DB.Query(`SELECT id, luna_id, scope_kind, scope_value, created_at, expires_at, last_opened_at
FROM share_links WHERE account_id = ? AND revoked_at = 0 AND expires_at > ?
ORDER BY created_at DESC, id DESC`, accountID, time.Now().Unix())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not list your links. Try again.")
		return
	}
	defer rows.Close()
	type linkItem struct {
		ID           string `json:"id"`
		LunaID       string `json:"luna_id"`
		ScopeKind    string `json:"scope_kind"`
		ScopeValue   string `json:"scope_value"`
		CreatedAt    int64  `json:"created_at"`
		ExpiresAt    int64  `json:"expires_at"`
		LastOpenedAt int64  `json:"last_opened_at"`
	}
	out := make([]linkItem, 0)
	for rows.Next() {
		var it linkItem
		if err := rows.Scan(&it.ID, &it.LunaID, &it.ScopeKind, &it.ScopeValue, &it.CreatedAt, &it.ExpiresAt, &it.LastOpenedAt); err != nil {
			JSONError(w, http.StatusInternalServerError, "Cloud storage could not list your links. Try again.")
			return
		}
		out = append(out, it)
	}
	if err := rows.Err(); err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not list your links. Try again.")
		return
	}
	JSON(w, http.StatusOK, map[string]any{"links": out})
}

// Revoke turns off one of the signed-in account's share links.
func (h ShareLinkHandler) Revoke(w http.ResponseWriter, r *http.Request) {
	accountID, ok := cloudAccountID(w, r)
	if !ok {
		return
	}
	res, err := h.DB.Exec(`UPDATE share_links SET revoked_at = ? WHERE id = ? AND account_id = ? AND revoked_at = 0`,
		time.Now().Unix(), chi.URLParam(r, "id"), accountID)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "Cloud storage could not turn off this link. Try again.")
		return
	}
	if n, err := res.RowsAffected(); err != nil || n == 0 {
		JSONError(w, http.StatusNotFound, shareAlreadyOff)
		return
	}
	JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// Info tells the link page what the link shares. It counts as opening the link.
func (h ShareLinkHandler) Info(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	now := time.Now()
	scope, linkID, ok := resolveShare(h.Deps, w, r, now)
	if !ok {
		return
	}
	var lunaName, sentBy string
	var expiresAt int64
	if err := h.DB.QueryRow(`SELECT COALESCE(d.name, ''), a.email, s.expires_at
FROM share_links s
JOIN accounts a ON a.id = s.account_id
LEFT JOIN luna_ids l ON l.account_id = s.account_id AND l.luna_id = s.luna_id
LEFT JOIN devices d ON d.id = l.device_id
WHERE s.id = ?`, linkID).Scan(&lunaName, &sentBy, &expiresAt); err != nil {
		JSONError(w, http.StatusInternalServerError, shareReadErrMessage)
		return
	}
	if _, err := h.DB.Exec(`UPDATE share_links SET last_opened_at = ? WHERE id = ?`, now.Unix(), linkID); err != nil {
		JSONError(w, http.StatusInternalServerError, shareReadErrMessage)
		return
	}
	JSON(w, http.StatusOK, map[string]any{
		"luna_id":    scope.LunaID,
		"luna_name":  lunaName,
		"sent_by":    sentBy,
		"scope":      map[string]string{"kind": scope.Kind, "value": scope.Value},
		"expires_at": expiresAt,
	})
}

// Records answers one kind of record for the link's scope.
func (h ShareLinkHandler) Records(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	scope, _, ok := resolveShare(h.Deps, w, r, time.Now())
	if !ok {
		return
	}
	writeRecords(h.Deps, w, scope, chi.URLParam(r, "kind"))
}

// Pack streams one pack the link's scope may read.
func (h ShareLinkHandler) Pack(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	scope, _, ok := resolveShare(h.Deps, w, r, time.Now())
	if !ok {
		return
	}
	writePack(h.Deps, w, scope, chi.URLParam(r, "id"))
}
