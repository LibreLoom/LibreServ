package handlers

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

// storageFixture builds an account with a card, one device token, and a chi
// router that mounts the storage routes behind DeviceAuth, as server.go does.
func storageFixture(t *testing.T, name string, quota int64) (http.Handler, Deps, string) {
	t.Helper()
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	_ = registerAccount(t, acctH, name+"@s.co")
	var acctID string
	_ = d.DB.QueryRow(`SELECT id FROM accounts WHERE email = ?`, name+"@s.co").Scan(&acctID)
	_, _ = d.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'active', backup_quota_bytes = ? WHERE id = ?`, quota, acctID)
	tok := "storage-token-" + name
	_, err := d.DB.Exec(`INSERT INTO devices (id, account_id, code_hash, name, subdomain, local_port, created_at)
VALUES (?, ?, ?, 'Luna', ?, 8090, ?)`, "dev_"+name, acctID, security.HashToken(security.NormalizeToken(tok)), name, time.Now().Unix())
	if err != nil {
		t.Fatal(err)
	}

	return storageRouter(d), d, tok
}

// storageRouter mounts the storage routes behind DeviceAuth, as server.go does.
func storageRouter(d Deps) http.Handler {
	stor := StorageHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	r := chi.NewRouter()
	r.Group(func(r chi.Router) {
		r.Use(devH.DeviceAuth)
		r.Put("/storage/packs/{id}", stor.PutPack)
		r.Get("/storage/packs/{id}", stor.GetPack)
		r.Delete("/storage/packs/{id}", stor.DeletePack)
		r.Put("/storage/records/{kind}/{name}", stor.PutRecord)
		r.Get("/storage/records/{kind}/{name}", stor.GetRecord)
		r.Delete("/storage/records/{kind}/{name}", stor.DeleteRecord)
		r.Get("/storage/records/{kind}", stor.ListRecords)
		r.Get("/storage/usage", stor.Usage)
		r.Get("/storage/luna-ids", stor.ListLunaIDs)
		r.Post("/storage/luna-ids/{id}/signing-public", stor.SetSigningPublic)
	})
	return r
}

// addStorageDevice adds a second device to the account that owns the fixture's
// device and returns its token.
func addStorageDevice(t *testing.T, d Deps, name, tok string) string {
	t.Helper()
	var acctID string
	if err := d.DB.QueryRow(`SELECT account_id FROM devices WHERE id = ?`, "dev_"+name).Scan(&acctID); err != nil {
		t.Fatal(err)
	}
	tok2 := tok + "-second"
	_, err := d.DB.Exec(`INSERT INTO devices (id, account_id, code_hash, name, subdomain, local_port, created_at)
VALUES (?, ?, ?, 'Second Luna', ?, 8091, ?)`, "dev_"+name+"-2", acctID, security.HashToken(security.NormalizeToken(tok2)), name+"-2", time.Now().Unix())
	if err != nil {
		t.Fatal(err)
	}
	return tok2
}

// countingStore counts Put and Delete calls and otherwise passes through.
type countingStore struct {
	store.Store
	puts, deletes int
}

func (s *countingStore) Put(accountID, deviceID, relPath string, r io.Reader) (int64, string, error) {
	s.puts++
	return s.Store.Put(accountID, deviceID, relPath, r)
}

func (s *countingStore) Delete(accountID, deviceID, relPath string) error {
	s.deletes++
	return s.Store.Delete(accountID, deviceID, relPath)
}

// signMove returns the X-Luna-Sig value a Luna sends when moving to deviceID.
func signMove(priv ed25519.PrivateKey, lunaID, deviceID string) string {
	return base64.StdEncoding.EncodeToString(ed25519.Sign(priv, []byte("luna-sig-v1\x00move\x00"+lunaID+deviceID)))
}

// fixtureAccountID returns the account that owns the fixture's device.
func fixtureAccountID(t *testing.T, d Deps, name string) string {
	t.Helper()
	var acctID string
	if err := d.DB.QueryRow(`SELECT account_id FROM devices WHERE id = ?`, "dev_"+name).Scan(&acctID); err != nil {
		t.Fatal(err)
	}
	return acctID
}

func storageDo(t *testing.T, h http.Handler, method, path, tok, lunaID string, body []byte, extra map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(method, "/storage"+path, bytes.NewReader(body))
	req.Header.Set("Authorization", "Bearer "+tok)
	if lunaID != "" {
		req.Header.Set("X-Luna-Id", lunaID)
	}
	for k, v := range extra {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestStoragePackRoundTrip(t *testing.T) {
	h, _, tok := storageFixture(t, "packs", 0)
	body := []byte("pack-bytes-here")
	sum := sha256.Sum256(body)
	id := hex.EncodeToString(sum[:])

	rec := storageDo(t, h, http.MethodPut, "/packs/"+id, tok, "luna1", body, map[string]string{"X-Luna-Scope": "albums"})
	if rec.Code != http.StatusOK {
		t.Fatalf("put %d %s", rec.Code, rec.Body.String())
	}
	again := storageDo(t, h, http.MethodPut, "/packs/"+id, tok, "luna1", body, nil)
	if again.Code != http.StatusOK {
		t.Fatalf("idempotent put %d %s", again.Code, again.Body.String())
	}

	get := storageDo(t, h, http.MethodGet, "/packs/"+id, tok, "luna1", nil, nil)
	if get.Code != http.StatusOK || get.Body.String() != string(body) {
		t.Fatalf("get %d %q", get.Code, get.Body.String())
	}

	del := storageDo(t, h, http.MethodDelete, "/packs/"+id, tok, "luna1", nil, nil)
	if del.Code != http.StatusNoContent {
		t.Fatalf("delete %d %s", del.Code, del.Body.String())
	}
	gone := storageDo(t, h, http.MethodGet, "/packs/"+id, tok, "luna1", nil, nil)
	if gone.Code != http.StatusNotFound {
		t.Fatalf("get after delete %d", gone.Code)
	}
	missing := storageDo(t, h, http.MethodDelete, "/packs/"+id, tok, "luna1", nil, nil)
	if missing.Code != http.StatusNoContent {
		t.Fatalf("delete missing %d", missing.Code)
	}
}

func TestStoragePackHashMismatch(t *testing.T) {
	h, d, tok := storageFixture(t, "mismatch", 0)
	rec := storageDo(t, h, http.MethodPut, "/packs/"+strings.Repeat("a", 64), tok, "luna1", []byte("not-that-hash"), nil)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("mismatch %d %s", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), "did not match") {
		t.Fatalf("plain sentence missing: %s", rec.Body.String())
	}
	var n int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM storage_packs`).Scan(&n)
	if n != 0 {
		t.Fatalf("mismatched pack was recorded")
	}
}

func TestStorageLunaIsolation(t *testing.T) {
	h, _, tok := storageFixture(t, "isolate", 0)
	body := []byte("only-luna-one")
	sum := sha256.Sum256(body)
	id := hex.EncodeToString(sum[:])
	if rec := storageDo(t, h, http.MethodPut, "/packs/"+id, tok, "luna1", body, nil); rec.Code != http.StatusOK {
		t.Fatalf("put %d", rec.Code)
	}
	other := storageDo(t, h, http.MethodGet, "/packs/"+id, tok, "luna2", nil, nil)
	if other.Code != http.StatusNotFound {
		t.Fatalf("other luna read %d", other.Code)
	}
	noID := storageDo(t, h, http.MethodGet, "/packs/"+id, tok, "", nil, nil)
	if noID.Code != http.StatusBadRequest {
		t.Fatalf("missing X-Luna-Id %d %s", noID.Code, noID.Body.String())
	}
}

func TestStorageRecords(t *testing.T) {
	h, _, tok := storageFixture(t, "records", 0)
	for _, name := range []string{"beta.json", "alpha.json"} {
		rec := storageDo(t, h, http.MethodPut, "/records/snapshot/"+name, tok, "luna1", []byte("v1"), nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("put %s %d %s", name, rec.Code, rec.Body.String())
		}
	}
	over := storageDo(t, h, http.MethodPut, "/records/snapshot/alpha.json", tok, "luna1", []byte("v2-new"), nil)
	if over.Code != http.StatusOK {
		t.Fatalf("overwrite %d", over.Code)
	}
	get := storageDo(t, h, http.MethodGet, "/records/snapshot/alpha.json", tok, "luna1", nil, nil)
	if get.Code != http.StatusOK || get.Body.String() != "v2-new" {
		t.Fatalf("get %d %q", get.Code, get.Body.String())
	}
	list := storageDo(t, h, http.MethodGet, "/records/snapshot", tok, "luna1", nil, nil)
	if list.Code != http.StatusOK || list.Body.String() != `{"names":["alpha.json","beta.json"]}`+"\n" {
		t.Fatalf("list %d %q", list.Code, list.Body.String())
	}
	bad := storageDo(t, h, http.MethodPut, "/records/snapshot/..%2Fescape", tok, "luna1", []byte("x"), nil)
	if bad.Code != http.StatusBadRequest {
		t.Fatalf("traversal name %d", bad.Code)
	}
	del := storageDo(t, h, http.MethodDelete, "/records/snapshot/alpha.json", tok, "luna1", nil, nil)
	if del.Code != http.StatusNoContent {
		t.Fatalf("delete %d", del.Code)
	}
	again := storageDo(t, h, http.MethodDelete, "/records/snapshot/alpha.json", tok, "luna1", nil, nil)
	if again.Code != http.StatusNoContent {
		t.Fatalf("second delete should be idempotent, got %d", again.Code)
	}
}

func TestStorageUsageAndQuota(t *testing.T) {
	h, _, tok := storageFixture(t, "quota", 10)
	rec := storageDo(t, h, http.MethodPut, "/records/cfg/key.bin", tok, "luna1", []byte("12345678"), nil)
	if rec.Code != http.StatusOK {
		t.Fatalf("first record %d %s", rec.Code, rec.Body.String())
	}
	full := storageDo(t, h, http.MethodPut, "/records/cfg/more.bin", tok, "luna1", []byte("123456789"), nil)
	if full.Code != http.StatusInsufficientStorage {
		t.Fatalf("over quota %d %s", full.Code, full.Body.String())
	}
	if !strings.Contains(full.Body.String(), "Your cloud storage is full.") {
		t.Fatalf("plain sentence missing: %s", full.Body.String())
	}

	body := []byte("0123456789ABCDEF")
	sum := sha256.Sum256(body)
	pack := storageDo(t, h, http.MethodPut, "/packs/"+hex.EncodeToString(sum[:]), tok, "luna1", body, nil)
	if pack.Code != http.StatusInsufficientStorage {
		t.Fatalf("pack over quota %d %s", pack.Code, pack.Body.String())
	}

	usage := storageDo(t, h, http.MethodGet, "/usage", tok, "luna1", nil, nil)
	if usage.Code != http.StatusOK || !strings.Contains(usage.Body.String(), `"used_bytes":8`) || !strings.Contains(usage.Body.String(), `"quota_bytes":10`) {
		t.Fatalf("usage %d %s", usage.Code, usage.Body.String())
	}
}

func TestStorageRequiresPaidAccount(t *testing.T) {
	h, d, tok := storageFixture(t, "unpaid", 0)
	_, _ = d.DB.Exec(`UPDATE accounts SET has_card = 0, billing_status = 'none'`)
	rec := storageDo(t, h, http.MethodPut, "/records/cfg/a.bin", tok, "luna1", []byte("x"), nil)
	if rec.Code != http.StatusPaymentRequired {
		t.Fatalf("unpaid write %d %s", rec.Code, rec.Body.String())
	}
}

func TestStoragePackBytesLiveInStore(t *testing.T) {
	h, deps, tok := storageFixture(t, "blobs", 0)
	body := []byte("exact-pack-bytes-\x00\x01\xff")
	sum := sha256.Sum256(body)
	id := hex.EncodeToString(sum[:])

	if rec := storageDo(t, h, http.MethodPut, "/packs/"+id, tok, "luna1", body, nil); rec.Code != http.StatusOK {
		t.Fatalf("put %d %s", rec.Code, rec.Body.String())
	}
	var accountID string
	if err := deps.DB.QueryRow(`SELECT id FROM accounts LIMIT 1`).Scan(&accountID); err != nil {
		t.Fatal(err)
	}
	rc, err := deps.Store.Get(accountID, store.StorageSlot("luna1"), store.StoragePackPath(id))
	if err != nil {
		t.Fatalf("pack is not in the store: %v", err)
	}
	defer rc.Close()
	stored, err := io.ReadAll(rc)
	if err != nil || !bytes.Equal(stored, body) {
		t.Fatalf("store holds %q, want %q (%v)", stored, body, err)
	}

	get := storageDo(t, h, http.MethodGet, "/packs/"+id, tok, "luna1", nil, nil)
	if get.Code != http.StatusOK || !bytes.Equal(get.Body.Bytes(), body) {
		t.Fatalf("get %d %q", get.Code, get.Body.String())
	}
}

func TestStorageDeleteIsIdempotent(t *testing.T) {
	h, _, tok := storageFixture(t, "idem", 0)
	for _, path := range []string{"/packs/" + strings.Repeat("a", 64), "/records/notes/missing"} {
		rec := storageDo(t, h, http.MethodDelete, path, tok, "luna1", nil, nil)
		if rec.Code != http.StatusNoContent {
			t.Fatalf("delete missing %s: %d %s", path, rec.Code, rec.Body.String())
		}
	}
}

func TestStorageSecondDeviceNeedsSignature(t *testing.T) {
	h, d, tok := storageFixture(t, "sigs", 0)
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keyHex := hex.EncodeToString(pub)
	// The first device claims the Luna and registers its signing key in one step.
	if rec := storageDo(t, h, http.MethodPut, "/records/identity/public", tok, "luna1", []byte(keyHex), nil); rec.Code != http.StatusOK {
		t.Fatalf("set key %d %s", rec.Code, rec.Body.String())
	}

	tok2 := addStorageDevice(t, d, "sigs", tok)
	// A second device with no signature is refused, and cannot replace the key either.
	if rec := storageDo(t, h, http.MethodGet, "/records/identity/public", tok2, "luna1", nil, nil); rec.Code != http.StatusForbidden {
		t.Fatalf("second device without sig: %d", rec.Code)
	}
	otherPub, otherPriv, _ := ed25519.GenerateKey(rand.Reader)
	_ = otherPub
	if rec := storageDo(t, h, http.MethodPut, "/records/identity/public", tok2, "luna1", []byte(hex.EncodeToString(otherPub)), nil); rec.Code != http.StatusForbidden {
		t.Fatalf("second device replacing key: %d", rec.Code)
	}
	// A signature from some other key is refused too.
	bad := map[string]string{"X-Luna-Sig": signMove(otherPriv, "luna1", "dev_sigs-2")}
	if rec := storageDo(t, h, http.MethodGet, "/records/identity/public", tok2, "luna1", nil, bad); rec.Code != http.StatusForbidden {
		t.Fatalf("wrong-key sig: %d", rec.Code)
	}

	// A signature from the Luna's own key moves it to the second device.
	good := map[string]string{"X-Luna-Sig": signMove(priv, "luna1", "dev_sigs-2")}
	if rec := storageDo(t, h, http.MethodGet, "/records/identity/public", tok2, "luna1", nil, good); rec.Code != http.StatusOK {
		t.Fatalf("takeover with valid sig: %d %s", rec.Code, rec.Body.String())
	}
	var owner, key string
	if err := d.DB.QueryRow(`SELECT device_id, signing_public FROM luna_ids WHERE luna_id = ?`, "luna1").Scan(&owner, &key); err != nil {
		t.Fatal(err)
	}
	if owner != "dev_sigs-2" || key != keyHex {
		t.Fatalf("owner %q key %q after takeover", owner, key)
	}
	// The first device has lost the Luna now.
	if rec := storageDo(t, h, http.MethodGet, "/records/identity/public", tok, "luna1", nil, nil); rec.Code != http.StatusForbidden {
		t.Fatalf("old device after takeover: %d", rec.Code)
	}
}

func TestStorageIdentityRecordSetsSigningKey(t *testing.T) {
	h, d, tok := storageFixture(t, "signkey", 0)
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	keyHex := hex.EncodeToString(pub)
	if rec := storageDo(t, h, http.MethodPut, "/records/identity/public", tok, "luna1", []byte(keyHex), nil); rec.Code != http.StatusOK {
		t.Fatalf("put identity %d %s", rec.Code, rec.Body.String())
	}
	var got string
	if err := d.DB.QueryRow(`SELECT signing_public FROM luna_ids WHERE luna_id = ?`, "luna1").Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != keyHex {
		t.Fatalf("signing key %q, want %q", got, keyHex)
	}
	// A key that is not 64 hex characters is refused and no signing key is stored.
	if rec := storageDo(t, h, http.MethodPut, "/records/identity/public", tok, "luna2", []byte("not-a-key"), nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad key %d", rec.Code)
	}
	var stored string
	if err := d.DB.QueryRow(`SELECT signing_public FROM luna_ids WHERE luna_id = ?`, "luna2").Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if stored != "" {
		t.Fatalf("bad key was stored as %q", stored)
	}
}

func TestStorageRepeatDeleteLeavesStoreAlone(t *testing.T) {
	_, d, tok := storageFixture(t, "deldup", 0)
	spy := &countingStore{Store: d.Store}
	d.Store = spy
	h := storageRouter(d)
	body := []byte("pack-for-delete")
	sum := sha256.Sum256(body)
	id := hex.EncodeToString(sum[:])
	if rec := storageDo(t, h, http.MethodPut, "/packs/"+id, tok, "luna1", body, nil); rec.Code != http.StatusOK {
		t.Fatalf("put %d", rec.Code)
	}
	for i := 0; i < 2; i++ {
		if rec := storageDo(t, h, http.MethodDelete, "/packs/"+id, tok, "luna1", nil, nil); rec.Code != http.StatusNoContent {
			t.Fatalf("delete %d: %d", i, rec.Code)
		}
	}
	if spy.deletes != 1 {
		t.Fatalf("store deletes %d, want 1 (the repeat must not touch the store)", spy.deletes)
	}
}

func TestStorageBadHashKeepsStoredPack(t *testing.T) {
	_, d, tok := storageFixture(t, "badhash", 0)
	spy := &countingStore{Store: d.Store}
	d.Store = spy
	h := storageRouter(d)

	good := []byte("good-pack")
	goodSum := sha256.Sum256(good)
	goodID := hex.EncodeToString(goodSum[:])
	if rec := storageDo(t, h, http.MethodPut, "/packs/"+goodID, tok, "luna1", good, nil); rec.Code != http.StatusOK {
		t.Fatalf("put good %d", rec.Code)
	}

	// A fresh ID whose bytes do not match: refused before the store is touched.
	other := []byte("other-pack")
	otherSum := sha256.Sum256(other)
	freshID := hex.EncodeToString(otherSum[:])
	rec := storageDo(t, h, http.MethodPut, "/packs/"+freshID, tok, "luna1", good, nil)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "did not match") {
		t.Fatalf("mismatch %d %s", rec.Code, rec.Body.String())
	}
	if spy.puts != 1 {
		t.Fatalf("store puts %d, want 1", spy.puts)
	}
	if get := storageDo(t, h, http.MethodGet, "/packs/"+freshID, tok, "luna1", nil, nil); get.Code != http.StatusNotFound {
		t.Fatalf("fresh id after mismatch: %d", get.Code)
	}
	if get := storageDo(t, h, http.MethodGet, "/packs/"+goodID, tok, "luna1", nil, nil); get.Code != http.StatusOK || get.Body.String() != string(good) {
		t.Fatalf("stored pack changed: %d %q", get.Code, get.Body.String())
	}
}

func TestStorageInsertFailureKeepsBlob(t *testing.T) {
	h, d, tok := storageFixture(t, "insfail", 0)
	if _, err := d.DB.Exec(`CREATE TRIGGER fail_pack_insert BEFORE INSERT ON storage_packs
BEGIN SELECT RAISE(ABORT, 'forced failure'); END`); err != nil {
		t.Fatal(err)
	}
	body := []byte("pack-insert-fails")
	sum := sha256.Sum256(body)
	id := hex.EncodeToString(sum[:])
	if rec := storageDo(t, h, http.MethodPut, "/packs/"+id, tok, "luna1", body, nil); rec.Code != http.StatusInternalServerError {
		t.Fatalf("put with failing insert %d", rec.Code)
	}
	// The bytes stay in the store; the pack is not recorded, so GET reports it missing.
	rc, err := d.Store.Get(fixtureAccountID(t, d, "insfail"), store.StorageSlot("luna1"), store.StoragePackPath(id))
	if err != nil {
		t.Fatalf("blob removed after insert failure: %v", err)
	}
	rc.Close()
	if get := storageDo(t, h, http.MethodGet, "/packs/"+id, tok, "luna1", nil, nil); get.Code != http.StatusNotFound {
		t.Fatalf("unrecorded pack readable: %d", get.Code)
	}
}
