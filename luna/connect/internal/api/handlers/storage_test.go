package handlers

import (
	"bytes"
	"crypto/sha256"
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
	})
	return r, d, tok
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
