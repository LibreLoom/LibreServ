package handlers

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
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

type gatedRecordStore struct {
	store.Store
	started chan struct{}
	release chan struct{}
	putErr  error
}

func (s *gatedRecordStore) Put(accountID, deviceID, relPath string, r io.Reader) (int64, string, error) {
	close(s.started)
	<-s.release
	if s.putErr != nil {
		return 0, "local", s.putErr
	}
	return s.Store.Put(accountID, deviceID, relPath, r)
}

// signMove returns the X-Luna-Sig and X-Luna-Ts headers a Luna sends to move to a
// new device, signed at time ts.
func signMove(t *testing.T, priv hybridKey, lunaID string, ts int64) map[string]string {
	t.Helper()
	tsStr := strconv.FormatInt(ts, 10)
	sig := priv.sign(t, "move", []byte(lunaID+"\x00"+tsStr))
	return map[string]string{
		"X-Luna-Sig": base64.StdEncoding.EncodeToString(sig),
		"X-Luna-Ts":  tsStr,
	}
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
	h, d, tok := storageFixture(t, "records", 0)
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
	var queued int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM storage_pending_deletes WHERE path = ?`, store.StorageRecordPath("snapshot", "alpha.json")).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 1 {
		t.Fatalf("pending record deletes %d, want 1", queued)
	}
	again := storageDo(t, h, http.MethodDelete, "/records/snapshot/alpha.json", tok, "luna1", nil, nil)
	if again.Code != http.StatusNoContent {
		t.Fatalf("second delete should be idempotent, got %d", again.Code)
	}
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM storage_pending_deletes WHERE path = ?`, store.StorageRecordPath("snapshot", "alpha.json")).Scan(&queued); err != nil {
		t.Fatal(err)
	}
	if queued != 1 {
		t.Fatalf("pending record deletes after retry %d, want 1", queued)
	}
}

func TestStorageRecordPagesUseKeysetCursorsAndReauthorizeEveryRequest(t *testing.T) {
	h, d, tok := storageFixture(t, "pages", 0)
	for _, name := range []string{"gamma.json", "alpha.json", "beta.json"} {
		if rec := storageDo(t, h, http.MethodPut, "/records/snapshots/"+name, tok, "luna1", []byte("v"), nil); rec.Code != http.StatusOK {
			t.Fatalf("put %s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
	if rec := storageDo(t, h, http.MethodPut, "/records/other-kind/alpha.json", tok, "luna1", []byte("v"), nil); rec.Code != http.StatusOK {
		t.Fatalf("put other kind: %d %s", rec.Code, rec.Body.String())
	}
	decodePage := func(rec *httptest.ResponseRecorder) (names []string, total int, next string, version uint64) {
		t.Helper()
		var body struct {
			Names     []string `json:"names"`
			Total     int      `json:"total"`
			NextAfter string   `json:"next_after"`
			Version   uint64   `json:"version"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode page: %v (%s)", err, rec.Body.String())
		}
		return body.Names, body.Total, body.NextAfter, body.Version
	}
	page := storageDo(t, h, http.MethodGet, "/records/snapshots?limit=1", tok, "luna1", nil, nil)
	if page.Code != http.StatusOK {
		t.Fatalf("first page %d %s", page.Code, page.Body.String())
	}
	firstNames, firstTotal, firstCursor, inventoryVersion := decodePage(page)
	if strings.Join(firstNames, ",") != "alpha.json" || firstTotal != 3 || firstCursor != "alpha.json" {
		t.Fatalf("unexpected first page: %v total=%d cursor=%q", firstNames, firstTotal, firstCursor)
	}
	// Same-count replacement changes the version even though page totals remain equal.
	if rec := storageDo(t, h, http.MethodDelete, "/records/snapshots/beta.json", tok, "luna1", nil, nil); rec.Code != http.StatusNoContent {
		t.Fatalf("delete beta: %d %s", rec.Code, rec.Body.String())
	}
	if rec := storageDo(t, h, http.MethodPut, "/records/snapshots/zeta.json", tok, "luna1", []byte("v"), nil); rec.Code != http.StatusOK {
		t.Fatalf("insert zeta: %d %s", rec.Code, rec.Body.String())
	}
	stale := storageDo(t, h, http.MethodGet, "/records/snapshots?limit=1&after=alpha.json&version="+strconv.FormatUint(inventoryVersion, 10)+"&total=3", tok, "luna1", nil, nil)
	if stale.Code != http.StatusConflict {
		t.Fatalf("same-count inventory replacement should expire its cursor, got %d %s", stale.Code, stale.Body.String())
	}
	var traversed []string
	cursor := ""
	version := uint64(0)
	for {
		path := "/records/snapshots?limit=1"
		if cursor != "" {
			path += "&after=" + cursor + "&version=" + strconv.FormatUint(version, 10) + "&total=3"
		}
		rec := storageDo(t, h, http.MethodGet, path, tok, "luna1", nil, nil)
		if rec.Code != http.StatusOK {
			t.Fatalf("retry page %q: %d %s", cursor, rec.Code, rec.Body.String())
		}
		names, _, next, pageVersion := decodePage(rec)
		if cursor == "" {
			version = pageVersion
		} else if pageVersion != version {
			t.Fatalf("version changed during retry: got %d want %d", pageVersion, version)
		}
		traversed = append(traversed, names...)
		if next == "" {
			break
		}
		cursor = next
	}
	if strings.Join(traversed, ",") != "alpha.json,gamma.json,zeta.json" {
		t.Fatalf("retry traversal duplicated or omitted names: %v", traversed)
	}
	empty := storageDo(t, h, http.MethodGet, "/records/snapshots?limit=1&after=zzzz&version="+strconv.FormatUint(version, 10)+"&total=3", tok, "luna1", nil, nil)
	if names, _, next, _ := decodePage(empty); empty.Code != http.StatusOK || len(names) != 0 || next != "" {
		t.Fatalf("past-end cursor should return an empty terminal page: status=%d names=%v next=%q", empty.Code, names, next)
	}

	for _, path := range []string{
		"/records/snapshots?limit=0",
		"/records/snapshots?limit=257",
		"/records/snapshots?limit=1&after=..%2Fescape",
		"/records/snapshots?limit=1&limit=2",
		"/records/snapshots?limit=1&version=-1",
		"/records/snapshots?limit=1&version=1&version=2",
		"/records/snapshots?limit=1&total=3",
	} {
		rec := storageDo(t, h, http.MethodGet, path, tok, "luna1", nil, nil)
		if rec.Code != http.StatusBadRequest {
			t.Errorf("invalid page request %q returned %d", path, rec.Code)
		}
	}
	secondDevice := addStorageDevice(t, d, "pages", tok)
	for _, path := range []string{"/records/snapshots?limit=1", "/records/snapshots?limit=1&after=alpha.json"} {
		rec := storageDo(t, h, http.MethodGet, path, secondDevice, "luna1", nil, nil)
		if rec.Code != http.StatusForbidden {
			t.Errorf("non-owner page request %q returned %d", path, rec.Code)
		}
	}
}

func TestRecordPagesWaitForPutAndRejectThePreviousInventory(t *testing.T) {
	h, d, tok := storageFixture(t, "pageputlock", 0)
	if rec := storageDo(t, h, http.MethodPut, "/records/snapshots/one.json", tok, "luna1", []byte("old"), nil); rec.Code != http.StatusOK {
		t.Fatalf("initial put %d %s", rec.Code, rec.Body.String())
	}
	first := storageDo(t, h, http.MethodGet, "/records/snapshots?limit=1", tok, "luna1", nil, nil)
	var before struct {
		Total   uint64 `json:"total"`
		Version uint64 `json:"version"`
	}
	if first.Code != http.StatusOK || json.Unmarshal(first.Body.Bytes(), &before) != nil || before.Total != 1 {
		t.Fatalf("initial inventory page %d %s", first.Code, first.Body.String())
	}

	gated := &gatedRecordStore{Store: d.Store, started: make(chan struct{}), release: make(chan struct{})}
	d.Store = gated
	h = storageRouter(d)
	putDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		putDone <- storageDo(t, h, http.MethodPut, "/records/snapshots/one.json", tok, "luna1", []byte("new"), nil)
	}()
	<-gated.started // Put holds the inventory row lock before touching object bytes.

	pageDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		path := "/records/snapshots?limit=1&after=one.json&version=" + strconv.FormatUint(before.Version, 10) + "&total=1"
		pageDone <- storageDo(t, h, http.MethodGet, path, tok, "luna1", nil, nil)
	}()
	select {
	case rec := <-pageDone:
		t.Fatalf("page accepted an inventory while its record write was pending: %d %s", rec.Code, rec.Body.String())
	case <-time.After(75 * time.Millisecond):
	}
	close(gated.release)
	if rec := <-putDone; rec.Code != http.StatusOK {
		t.Fatalf("replacement put %d %s", rec.Code, rec.Body.String())
	}
	if rec := <-pageDone; rec.Code != http.StatusConflict {
		t.Fatalf("old continuation should be rejected after replacement, got %d %s", rec.Code, rec.Body.String())
	}
	current := storageDo(t, h, http.MethodGet, "/records/snapshots?limit=1", tok, "luna1", nil, nil)
	var after struct {
		Version uint64 `json:"version"`
	}
	if current.Code != http.StatusOK || json.Unmarshal(current.Body.Bytes(), &after) != nil || after.Version == before.Version {
		t.Fatalf("new page did not expose a new generation: before=%d response=%d %s", before.Version, current.Code, current.Body.String())
	}
}

func TestFailedRecordPutStillInvalidatesItsPages(t *testing.T) {
	h, d, tok := storageFixture(t, "failedpageput", 0)
	if rec := storageDo(t, h, http.MethodPut, "/records/snapshots/one.json", tok, "luna1", []byte("old"), nil); rec.Code != http.StatusOK {
		t.Fatalf("initial put %d %s", rec.Code, rec.Body.String())
	}
	first := storageDo(t, h, http.MethodGet, "/records/snapshots?limit=1", tok, "luna1", nil, nil)
	var before struct {
		Total   uint64 `json:"total"`
		Version uint64 `json:"version"`
	}
	if first.Code != http.StatusOK || json.Unmarshal(first.Body.Bytes(), &before) != nil {
		t.Fatalf("initial inventory page %d %s", first.Code, first.Body.String())
	}
	gated := &gatedRecordStore{Store: d.Store, started: make(chan struct{}), release: make(chan struct{}), putErr: io.ErrUnexpectedEOF}
	d.Store = gated
	h = storageRouter(d)
	putDone := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		putDone <- storageDo(t, h, http.MethodPut, "/records/snapshots/one.json", tok, "luna1", []byte("partial"), nil)
	}()
	<-gated.started
	close(gated.release)
	if rec := <-putDone; rec.Code != http.StatusBadRequest {
		t.Fatalf("failed replacement put %d %s", rec.Code, rec.Body.String())
	}
	path := "/records/snapshots?limit=1&after=one.json&version=" + strconv.FormatUint(before.Version, 10) + "&total=" + strconv.FormatUint(before.Total, 10)
	stale := storageDo(t, h, http.MethodGet, path, tok, "luna1", nil, nil)
	if stale.Code != http.StatusConflict {
		t.Fatalf("failed write should invalidate old pages, got %d %s", stale.Code, stale.Body.String())
	}
}

func TestRecordRowFailureStillPublishesTheObjectChangeGeneration(t *testing.T) {
	h, d, tok := storageFixture(t, "recordrowfailure", 0)
	if rec := storageDo(t, h, http.MethodPut, "/records/snapshots/one.json", tok, "luna1", []byte("old"), nil); rec.Code != http.StatusOK {
		t.Fatalf("initial put %d %s", rec.Code, rec.Body.String())
	}
	first := storageDo(t, h, http.MethodGet, "/records/snapshots?limit=1", tok, "luna1", nil, nil)
	var before struct {
		Total   uint64 `json:"total"`
		Version uint64 `json:"version"`
	}
	if first.Code != http.StatusOK || json.Unmarshal(first.Body.Bytes(), &before) != nil {
		t.Fatalf("initial inventory page %d %s", first.Code, first.Body.String())
	}
	if _, err := d.DB.Exec(`CREATE TRIGGER fail_storage_record_update BEFORE UPDATE ON storage_records
BEGIN SELECT RAISE(ABORT, 'test row failure'); END`); err != nil {
		t.Fatal(err)
	}
	failed := storageDo(t, h, http.MethodPut, "/records/snapshots/one.json", tok, "luna1", []byte("new-bytes"), nil)
	if failed.Code != http.StatusInternalServerError {
		t.Fatalf("row failure should be reported, got %d %s", failed.Code, failed.Body.String())
	}
	_, _ = d.DB.Exec(`DROP TRIGGER fail_storage_record_update`)
	path := "/records/snapshots?limit=1&after=one.json&version=" + strconv.FormatUint(before.Version, 10) + "&total=" + strconv.FormatUint(before.Total, 10)
	stale := storageDo(t, h, http.MethodGet, path, tok, "luna1", nil, nil)
	if stale.Code != http.StatusConflict {
		t.Fatalf("row failure after object replacement must invalidate old pages, got %d %s", stale.Code, stale.Body.String())
	}
	current := storageDo(t, h, http.MethodGet, "/records/snapshots/one.json", tok, "luna1", nil, nil)
	if current.Code != http.StatusOK || current.Body.String() != "new-bytes" {
		t.Fatalf("object write outcome changed unexpectedly: %d %q", current.Code, current.Body.String())
	}
}

func TestStorageRecordPagesCanBeBoundedToAValidatedPrefix(t *testing.T) {
	h, d, tok := storageFixture(t, "prefixpages", 0)
	for _, name := range []string{"scope-a.1", "scope-a.2", "scope-b.1", "scope-ax.1"} {
		if rec := storageDo(t, h, http.MethodPut, "/records/psnapshots/"+name, tok, "luna1", []byte("v"), nil); rec.Code != http.StatusOK {
			t.Fatalf("put %s: %d %s", name, rec.Code, rec.Body.String())
		}
	}
	request := func(path string) (names []string, total int, next string, version uint64, status int) {
		t.Helper()
		rec := storageDo(t, h, http.MethodGet, path, tok, "luna1", nil, nil)
		var body struct {
			Names     []string `json:"names"`
			Total     int      `json:"total"`
			NextAfter string   `json:"next_after"`
			Version   uint64   `json:"version"`
		}
		if rec.Code == http.StatusOK {
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatalf("decode page: %v (%s)", err, rec.Body.String())
			}
		}
		return body.Names, body.Total, body.NextAfter, body.Version, rec.Code
	}
	first, total, cursor, version, status := request("/records/psnapshots?limit=1&prefix=scope-a.")
	if status != http.StatusOK || strings.Join(first, ",") != "scope-a.1" || total != 2 || cursor != "scope-a.1" {
		t.Fatalf("first scoped page: status=%d names=%v total=%d cursor=%q", status, first, total, cursor)
	}
	last, total, cursor, lastVersion, status := request("/records/psnapshots?limit=1&prefix=scope-a.&after=scope-a.1&version=" + strconv.FormatUint(version, 10) + "&total=2")
	if status != http.StatusOK || strings.Join(last, ",") != "scope-a.2" || total != 2 || cursor != "" || lastVersion != version {
		t.Fatalf("last scoped page: status=%d names=%v total=%d cursor=%q", status, last, total, cursor)
	}
	for _, path := range []string{
		"/records/psnapshots?limit=1&prefix=scope-a",
		"/records/psnapshots?limit=1&prefix=scope-a.&after=scope-b.1",
		"/records/psnapshots?limit=1&prefix=scope-a.&prefix=scope-b.",
	} {
		_, _, _, _, status := request(path)
		if status != http.StatusBadRequest {
			t.Errorf("invalid scoped page %q returned %d", path, status)
		}
	}
	secondDevice := addStorageDevice(t, d, "prefixpages", tok)
	for _, path := range []string{
		"/records/psnapshots?limit=1&prefix=scope-a.",
		"/records/psnapshots?limit=1&prefix=scope-a.&after=scope-a.1",
	} {
		rec := storageDo(t, h, http.MethodGet, path, secondDevice, "luna1", nil, nil)
		if rec.Code != http.StatusForbidden {
			t.Errorf("non-owner scoped page request %q returned %d", path, rec.Code)
		}
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
	priv := newHybridKey(t)
	keyHex := priv.pubHex()
	// The first device claims the Luna and registers its signing key in one step.
	if rec := storageDo(t, h, http.MethodPut, "/records/identity/public", tok, "luna1", []byte(keyHex), nil); rec.Code != http.StatusOK {
		t.Fatalf("set key %d %s", rec.Code, rec.Body.String())
	}

	tok2 := addStorageDevice(t, d, "sigs", tok)
	// A second device with no signature is refused, and cannot replace the key either.
	if rec := storageDo(t, h, http.MethodGet, "/records/identity/public", tok2, "luna1", nil, nil); rec.Code != http.StatusForbidden {
		t.Fatalf("second device without sig: %d", rec.Code)
	}
	otherPriv := newHybridKey(t)
	if rec := storageDo(t, h, http.MethodPut, "/records/identity/public", tok2, "luna1", []byte(otherPriv.pubHex()), nil); rec.Code != http.StatusForbidden {
		t.Fatalf("second device replacing key: %d", rec.Code)
	}
	// A signature from some other key is refused too.
	bad := signMove(t, otherPriv, "luna1", time.Now().Unix())
	if rec := storageDo(t, h, http.MethodGet, "/records/identity/public", tok2, "luna1", nil, bad); rec.Code != http.StatusForbidden {
		t.Fatalf("wrong-key sig: %d", rec.Code)
	}

	// A signature from the Luna's own key moves it to the second device.
	good := signMove(t, priv, "luna1", time.Now().Unix())
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
	keyHex := newHybridKey(t).pubHex()
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
	// A bad key is rejected before the Luna id is claimed.
	if rec := storageDo(t, h, http.MethodPut, "/records/identity/public", tok, "luna2", []byte("not-a-key"), nil); rec.Code != http.StatusBadRequest {
		t.Fatalf("bad key %d", rec.Code)
	}
	var rows int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM luna_ids WHERE luna_id = ?`, "luna2").Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("invalid key claimed luna2: rows=%d", rows)
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
	// The bytes wait out the grace period: nothing is removed yet, and one reminder is queued.
	if spy.deletes != 0 {
		t.Fatalf("store deletes %d, want 0 (removal waits for the grace period)", spy.deletes)
	}
	var queued int
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM storage_pending_deletes`).Scan(&queued)
	if queued != 1 {
		t.Fatalf("pending deletes %d, want 1", queued)
	}
	// Storing the same pack again keeps it.
	if rec := storageDo(t, h, http.MethodPut, "/packs/"+id, tok, "luna1", body, nil); rec.Code != http.StatusOK {
		t.Fatalf("re-put %d", rec.Code)
	}
	_ = d.DB.QueryRow(`SELECT COUNT(*) FROM storage_pending_deletes`).Scan(&queued)
	if queued != 0 {
		t.Fatalf("pending deletes after re-upload %d, want 0", queued)
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

func TestStorageMoveSignatureMustBeFresh(t *testing.T) {
	h, d, tok := storageFixture(t, "fresh", 0)
	priv := newHybridKey(t)
	if rec := storageDo(t, h, http.MethodPut, "/records/identity/public", tok, "luna1", []byte(priv.pubHex()), nil); rec.Code != http.StatusOK {
		t.Fatalf("set key %d", rec.Code)
	}
	tok2 := addStorageDevice(t, d, "fresh", tok)
	now := time.Now().Unix()
	for _, ts := range []int64{now - 301, now + 301} {
		if rec := storageDo(t, h, http.MethodGet, "/records/identity/public", tok2, "luna1", nil, signMove(t, priv, "luna1", ts)); rec.Code != http.StatusForbidden {
			t.Fatalf("signature at %d accepted: %d", ts, rec.Code)
		}
	}
	// A signature for a different Luna does not move this one.
	if rec := storageDo(t, h, http.MethodGet, "/records/identity/public", tok2, "luna1", nil, signMove(t, priv, "luna2", now)); rec.Code != http.StatusForbidden {
		t.Fatalf("signature for another Luna accepted: %d", rec.Code)
	}
	// A timestamp inside the window moves the Luna.
	if rec := storageDo(t, h, http.MethodGet, "/records/identity/public", tok2, "luna1", nil, signMove(t, priv, "luna1", now-299)); rec.Code != http.StatusOK {
		t.Fatalf("fresh signature refused: %d %s", rec.Code, rec.Body.String())
	}
}

func TestStorageReadDoesNotClaimLuna(t *testing.T) {
	h, d, tok := storageFixture(t, "readonly", 0)
	if rec := storageDo(t, h, http.MethodGet, "/records/identity/public", tok, "ghost", nil, nil); rec.Code != http.StatusNotFound {
		t.Fatalf("read of unknown Luna: %d", rec.Code)
	}
	var n int
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM luna_ids WHERE luna_id = ?`, "ghost").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 0 {
		t.Fatalf("read created %d luna_ids rows", n)
	}
	if rec := storageDo(t, h, http.MethodPut, "/records/notes/a", tok, "ghost", []byte("hi"), nil); rec.Code != http.StatusOK {
		t.Fatalf("write %d", rec.Code)
	}
	if err := d.DB.QueryRow(`SELECT COUNT(*) FROM luna_ids WHERE luna_id = ?`, "ghost").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Fatalf("write did not claim the Luna: %d rows", n)
	}
}

func TestStorageNonOwnerCannotSetFirstSigningKey(t *testing.T) {
	h, d, tok := storageFixture(t, "nokey", 0)
	if rec := storageDo(t, h, http.MethodPut, "/records/notes/a", tok, "luna1", []byte("hi"), nil); rec.Code != http.StatusOK {
		t.Fatalf("claim %d", rec.Code)
	}
	tok2 := addStorageDevice(t, d, "nokey", tok)
	pub := newHybridKey(t).pub
	if rec := storageDo(t, h, http.MethodPut, "/records/identity/public", tok2, "luna1", []byte(hex.EncodeToString(pub)), nil); rec.Code != http.StatusForbidden {
		t.Fatalf("non-owner set first key: %d", rec.Code)
	}
	if rec := storageDo(t, h, http.MethodPost, "/luna-ids/luna1/signing-public", tok2, "", []byte(hex.EncodeToString(pub)), nil); rec.Code != http.StatusForbidden {
		t.Fatalf("non-owner POST first key: %d", rec.Code)
	}
	var owner, key string
	if err := d.DB.QueryRow(`SELECT device_id, signing_public FROM luna_ids WHERE luna_id = ?`, "luna1").Scan(&owner, &key); err != nil {
		t.Fatal(err)
	}
	if owner != "dev_nokey" || key != "" {
		t.Fatalf("owner %q key %q after refused takeover", owner, key)
	}
}

func TestRecordPackUpdatesBackend(t *testing.T) {
	_, d, _ := storageFixture(t, "packback", 0)
	acctID := fixtureAccountID(t, d, "packback")
	id := strings.Repeat("ab", 32)
	if err := recordPack(d.DB.DB, acctID, "luna1", id, "", 5, "local"); err != nil {
		t.Fatal(err)
	}
	if err := recordPack(d.DB.DB, acctID, "luna1", id, "", 5, "b2"); err != nil {
		t.Fatal(err)
	}
	var backend string
	var n int
	if err := d.DB.QueryRow(`SELECT storage_backend, COUNT(*) FROM storage_packs WHERE account_id = ? AND id = ?`, acctID, id).Scan(&backend, &n); err != nil {
		t.Fatal(err)
	}
	if n != 1 || backend != "b2" {
		t.Fatalf("rows %d backend %q, want 1 row on b2", n, backend)
	}
}

func TestStorageLunaCapPerAccount(t *testing.T) {
	h, _, tok := storageFixture(t, "lunacap", 0)
	for i := 0; i < maxLunasPerAccount; i++ {
		id := "luna-cap" + strconv.Itoa(i)
		if rec := storageDo(t, h, http.MethodPut, "/records/self/a", tok, id, []byte("x"), nil); rec.Code != http.StatusOK {
			t.Fatalf("luna %d: %d %s", i, rec.Code, rec.Body.String())
		}
	}
	if rec := storageDo(t, h, http.MethodPut, "/records/self/a", tok, "luna-onetoomany", []byte("x"), nil); rec.Code != http.StatusConflict {
		t.Fatalf("over the cap = %d, want 409", rec.Code)
	}
	// A Luna the account already has still works.
	if rec := storageDo(t, h, http.MethodPut, "/records/self/b", tok, "luna-cap0", []byte("x"), nil); rec.Code != http.StatusOK {
		t.Fatalf("existing luna = %d", rec.Code)
	}
}
