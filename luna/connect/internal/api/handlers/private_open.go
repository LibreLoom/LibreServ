package handlers

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

const privateChallengeTTL = 5 * 60

// maxPrivateChallenges is how many unspent challenges one Luna and link may hold at once.
const maxPrivateChallenges = 20
const privateSessionTTL = 30 * 60
const privateOpenDomain = "private-open"
const privateScopeDomain = "private-scope"
const privateTokenMessage = "Enter your recovery phrase again to open your private items."

const privateOpenReadErr = "Cloud storage could not open your private items. Try again."

// errPrivateDenied is every refusal that the caller should see as the same 403.
var errPrivateDenied = errors.New("private open denied")

// errTooManyChallenges means the Luna and link already hold their limit of unspent challenges.
var errTooManyChallenges = errors.New("too many open challenges")

// lunaCanonical mirrors crypto::canonical: for each field, u32 BE len(name) ‖ name ‖ u32 BE len(value) ‖ value.
func lunaCanonical(fields ...[2][]byte) []byte {
	var buf bytes.Buffer
	for _, f := range fields {
		_ = binary.Write(&buf, binary.BigEndian, uint32(len(f[0])))
		buf.Write(f[0])
		_ = binary.Write(&buf, binary.BigEndian, uint32(len(f[1])))
		buf.Write(f[1])
	}
	return buf.Bytes()
}

// lunaVerify checks Ed25519 over "luna-sig-v1\x00" + domain + "\x00" + msg.
func lunaVerify(pub []byte, domain string, msg, sig []byte) bool {
	if len(pub) != ed25519.PublicKeySize || len(sig) != ed25519.SignatureSize {
		return false
	}
	signed := append([]byte("luna-sig-v1\x00"+domain+"\x00"), msg...)
	return ed25519.Verify(pub, signed, sig)
}

// scopePart is the share-link value for one user: hex(sha256(userID)[:16]).
func scopePart(userID string) string {
	sum := sha256.Sum256([]byte(userID))
	return hex.EncodeToString(sum[:16])
}

// sealPublicLen is a user's public sealing key: X25519 public key (32) then ML-KEM-768 encapsulation key (1184).
const sealPublicLen = 32 + 1184

// scopeRecord is the verified contents of a pscopes/<scope> record.
type scopeRecord struct {
	LunaID      string
	Scope       string
	UserID      string
	SealPublic  []byte
	AuthPublic  []byte
	CreatedAt   int64
	SealedDedup []byte
}

// scopeRecordWire is the pscopes JSON: {"record":{...},"signature":"<hex>"}.
type scopeRecordWire struct {
	Record struct {
		LunaID      string `json:"luna_id"`
		Scope       string `json:"scope"`
		UserID      string `json:"user_id"`
		SealPublic  string `json:"seal_public"`
		AuthPublic  string `json:"auth_public"`
		CreatedAt   int64  `json:"created_at"`
		SealedDedup string `json:"sealed_dedup"`
	} `json:"record"`
	Signature string `json:"signature"`
}

// parseScopeRecord decodes the pscopes JSON (hex fields) and verifies its signature with the Luna's signing key.
func parseScopeRecord(data []byte, lunaSigningHex string) (scopeRecord, bool) {
	var w scopeRecordWire
	if err := json.Unmarshal(data, &w); err != nil {
		return scopeRecord{}, false
	}
	sealPublic, err1 := hex.DecodeString(w.Record.SealPublic)
	auth, err2 := hex.DecodeString(w.Record.AuthPublic)
	sealed, err3 := hex.DecodeString(w.Record.SealedDedup)
	sig, err4 := hex.DecodeString(w.Signature)
	signing, err5 := hex.DecodeString(lunaSigningHex)
	if err1 != nil || err2 != nil || err3 != nil || err4 != nil || err5 != nil {
		return scopeRecord{}, false
	}
	if len(sealPublic) != sealPublicLen || len(auth) != 32 {
		return scopeRecord{}, false
	}
	var created [8]byte
	binary.BigEndian.PutUint64(created[:], uint64(w.Record.CreatedAt))
	msg := lunaCanonical(
		[2][]byte{[]byte("luna_id"), []byte(w.Record.LunaID)},
		[2][]byte{[]byte("scope"), []byte(w.Record.Scope)},
		[2][]byte{[]byte("user_id"), []byte(w.Record.UserID)},
		[2][]byte{[]byte("seal_public"), sealPublic},
		[2][]byte{[]byte("auth_public"), auth},
		[2][]byte{[]byte("created_at"), created[:]},
		[2][]byte{[]byte("sealed_dedup"), sealed},
	)
	if !lunaVerify(signing, privateScopeDomain, msg, sig) {
		return scopeRecord{}, false
	}
	return scopeRecord{
		LunaID:      w.Record.LunaID,
		Scope:       w.Record.Scope,
		UserID:      w.Record.UserID,
		SealPublic:  sealPublic,
		AuthPublic:  auth,
		CreatedAt:   w.Record.CreatedAt,
		SealedDedup: sealed,
	}, true
}

// loadScopeRecord reads pscopes/<scope> for s (account, luna) and verifies it. ok=false if missing or bad.
func loadScopeRecord(d Deps, s readScope, scope string) (scopeRecord, bool, error) {
	if !storageScopePattern.MatchString(scope) {
		return scopeRecord{}, false, nil
	}
	_, signingHex, found, err := lookupLuna(d, s.AccountID, s.LunaID)
	if err != nil {
		return scopeRecord{}, false, err
	}
	if !found {
		return scopeRecord{}, false, nil
	}
	rc, err := d.Store.Get(s.AccountID, store.StorageSlot(s.LunaID), store.StorageRecordPath("pscopes", scope))
	if errors.Is(err, fs.ErrNotExist) {
		return scopeRecord{}, false, nil
	}
	if err != nil {
		return scopeRecord{}, false, err
	}
	data, err := io.ReadAll(io.LimitReader(rc, maxStorageRecordBytes+1))
	rc.Close()
	if err != nil {
		return scopeRecord{}, false, err
	}
	if len(data) > maxStorageRecordBytes {
		return scopeRecord{}, false, nil
	}
	rec, ok := parseScopeRecord(data, signingHex)
	if !ok || rec.LunaID != s.LunaID || rec.Scope != scope {
		return scopeRecord{}, false, nil
	}
	return rec, true, nil
}

// randomHex returns n random bytes as hex.
func randomHex(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

// newPrivateChallenge stores and returns a fresh 32-byte challenge (hex).
func newPrivateChallenge(d Deps, s readScope, linkID string, now time.Time) (string, error) {
	challenge, err := randomHex(32)
	if err != nil {
		return "", err
	}
	if _, err := d.DB.Exec(`DELETE FROM private_challenges WHERE expires_at < ?`, now.Unix()); err != nil {
		return "", err
	}
	if _, err := d.DB.Exec(`DELETE FROM private_sessions WHERE expires_at < ?`, now.Unix()); err != nil {
		return "", err
	}
	var open int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM private_challenges WHERE account_id = ? AND luna_id = ? AND link_id = ?`,
		s.AccountID, s.LunaID, linkID).Scan(&open); err != nil {
		return "", err
	}
	if open >= maxPrivateChallenges {
		return "", errTooManyChallenges
	}
	if _, err := d.DB.Exec(`INSERT INTO private_challenges (hash, account_id, luna_id, link_id, expires_at)
VALUES (?, ?, ?, ?, ?)`, security.HashToken(challenge), s.AccountID, s.LunaID, linkID, now.Add(privateChallengeTTL*time.Second).Unix()); err != nil {
		return "", err
	}
	return challenge, nil
}

// openPrivateSession checks challenge (single use, not expired, same account/luna/link) and the
// auth-key signature against the scope record's auth_public, and for a user share link that
// scopePart(record.UserID) == s.Value. A backup link (s.Kind == "backup") never opens one.
// Returns the token (hex 32 bytes) and expiry.
func openPrivateSession(d Deps, s readScope, linkID, scope, challengeHex, sigHex string, now time.Time) (token string, expiresAt int64, err error) {
	challengeHex = strings.ToLower(challengeHex)
	challenge, err := hex.DecodeString(challengeHex)
	if err != nil || len(challenge) != 32 {
		return "", 0, errPrivateDenied
	}
	sig, err := hex.DecodeString(sigHex)
	if err != nil {
		return "", 0, errPrivateDenied
	}
	if linkID == "" && s.Kind != "" || linkID != "" && s.Kind != "user" {
		return "", 0, errPrivateDenied
	}

	// The challenge is spent here, whether or not the rest of the check passes.
	res, err := d.DB.Exec(`DELETE FROM private_challenges
WHERE hash = ? AND account_id = ? AND luna_id = ? AND link_id = ? AND expires_at > ?`,
		security.HashToken(challengeHex), s.AccountID, s.LunaID, linkID, now.Unix())
	if err != nil {
		return "", 0, err
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return "", 0, errPrivateDenied
	}

	rec, ok, err := loadScopeRecord(d, s, scope)
	if err != nil {
		return "", 0, err
	}
	if !ok || rec.Scope != scope {
		return "", 0, errPrivateDenied
	}
	if s.Kind == "user" && scopePart(rec.UserID) != s.Value {
		return "", 0, errPrivateDenied
	}
	msg := lunaCanonical(
		[2][]byte{[]byte("luna_id"), []byte(s.LunaID)},
		[2][]byte{[]byte("scope"), []byte(scope)},
		[2][]byte{[]byte("challenge"), challenge},
	)
	if !lunaVerify(rec.AuthPublic, privateOpenDomain, msg, sig) {
		return "", 0, errPrivateDenied
	}

	token, err = randomHex(32)
	if err != nil {
		return "", 0, err
	}
	expiresAt = now.Add(privateSessionTTL * time.Second).Unix()
	if _, err := d.DB.Exec(`INSERT INTO private_sessions (token_hash, account_id, luna_id, scope, link_id, expires_at)
VALUES (?, ?, ?, ?, ?, ?)`, security.HashToken(token), s.AccountID, s.LunaID, scope, linkID, expiresAt); err != nil {
		return "", 0, err
	}
	return token, expiresAt, nil
}

// privateSessionScope returns the scope a token opens, or "" if invalid/expired/other luna or link.
func privateSessionScope(d Deps, s readScope, linkID, token string, now time.Time) (string, error) {
	var scope string
	err := d.DB.QueryRow(`SELECT scope FROM private_sessions
WHERE token_hash = ? AND account_id = ? AND luna_id = ? AND link_id = ? AND expires_at > ?`,
		security.HashToken(strings.ToLower(token)), s.AccountID, s.LunaID, linkID, now.Unix()).Scan(&scope)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	return scope, nil
}

// PrivateHandler serves the HTTP side; T14 wires the routes.
type PrivateHandler struct{ Deps }

type privateOpenBody struct {
	Scope     string `json:"scope"`
	Challenge string `json:"challenge"`
	Signature string `json:"signature"`
}

// readPrivateOpen decodes the open body, writing the 400 itself when it cannot be read.
func readPrivateOpen(w http.ResponseWriter, r *http.Request) (privateOpenBody, bool) {
	var body privateOpenBody
	if err := json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&body); err != nil {
		JSONError(w, http.StatusBadRequest, "That request could not be read. Try again.")
		return body, false
	}
	return body, true
}

// writePrivateOpenErr writes the 403 for any refusal, or a 500 for a storage failure.
func writePrivateOpenErr(w http.ResponseWriter, err error) {
	if errors.Is(err, errPrivateDenied) {
		JSONError(w, http.StatusForbidden, privateTokenMessage)
		return
	}
	JSONError(w, http.StatusInternalServerError, privateOpenReadErr)
}

// writeChallenge sends a new challenge and its expiry as JSON.
func writeChallenge(d Deps, w http.ResponseWriter, s readScope, linkID string, now time.Time) {
	challenge, err := newPrivateChallenge(d, s, linkID, now)
	if errors.Is(err, errTooManyChallenges) {
		JSONError(w, http.StatusTooManyRequests, "Too many sign-in attempts are open. Wait a few minutes, then try again.")
		return
	}
	if err != nil {
		JSONError(w, http.StatusInternalServerError, privateOpenReadErr)
		return
	}
	JSON(w, http.StatusOK, map[string]any{
		"challenge":  challenge,
		"expires_at": now.Add(privateChallengeTTL * time.Second).Unix(),
	})
}

// Challenge issues a challenge for one Luna on the signed-in account.
func (h PrivateHandler) Challenge(w http.ResponseWriter, r *http.Request) {
	accountID, ok := cloudAccountID(w, r)
	if !ok {
		return
	}
	lunaID := chi.URLParam(r, "lunaID")
	if !cloudLunaOnAccount(h.Deps, accountID, lunaID) {
		JSONError(w, http.StatusNotFound, "That Luna has no cloud backups on this account.")
		return
	}
	writeChallenge(h.Deps, w, readScope{AccountID: accountID, LunaID: lunaID}, "", time.Now())
}

// Open exchanges a signed challenge for a private session token on the signed-in account.
func (h PrivateHandler) Open(w http.ResponseWriter, r *http.Request) {
	accountID, ok := cloudAccountID(w, r)
	if !ok {
		return
	}
	lunaID := chi.URLParam(r, "lunaID")
	if !cloudLunaOnAccount(h.Deps, accountID, lunaID) {
		JSONError(w, http.StatusNotFound, "That Luna has no cloud backups on this account.")
		return
	}
	body, ok := readPrivateOpen(w, r)
	if !ok {
		return
	}
	now := time.Now()
	token, expiresAt, err := openPrivateSession(h.Deps, readScope{AccountID: accountID, LunaID: lunaID}, "", body.Scope, body.Challenge, body.Signature, now)
	if err != nil {
		writePrivateOpenErr(w, err)
		return
	}
	JSON(w, http.StatusOK, map[string]any{"token": token, "expires_at": expiresAt})
}

// ShareChallenge issues a challenge for a user share link. Other links never get one.
func (h PrivateHandler) ShareChallenge(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	s, linkID, ok := resolveShare(h.Deps, w, r, now)
	if !ok {
		return
	}
	if s.Kind != "user" {
		JSONError(w, http.StatusForbidden, privateTokenMessage)
		return
	}
	writeChallenge(h.Deps, w, s, linkID, now)
}

// ShareOpen exchanges a signed challenge for a private session token through a user share link.
func (h PrivateHandler) ShareOpen(w http.ResponseWriter, r *http.Request) {
	now := time.Now()
	s, linkID, ok := resolveShare(h.Deps, w, r, now)
	if !ok {
		return
	}
	if s.Kind != "user" {
		JSONError(w, http.StatusForbidden, privateTokenMessage)
		return
	}
	body, ok := readPrivateOpen(w, r)
	if !ok {
		return
	}
	token, expiresAt, err := openPrivateSession(h.Deps, s, linkID, body.Scope, body.Challenge, body.Signature, now)
	if err != nil {
		writePrivateOpenErr(w, err)
		return
	}
	JSON(w, http.StatusOK, map[string]any{"token": token, "expires_at": expiresAt})
}
