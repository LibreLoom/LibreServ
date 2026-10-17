package handlers

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

const (
	cloudProtA = "11111111-1111-1111-1111-111111111111"
	cloudProtB = "22222222-2222-2222-2222-222222222222"
	cloudUserA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	cloudUserB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	cloudUserC = "cccccccccccccccccccccccccccccccc"
)

// cloudReq builds a request with several chi URL params and the signed-in account in its context.
func cloudReq(accountID, method, target string, params map[string]string) *http.Request {
	req := httptest.NewRequest(method, target, nil)
	rctx := chi.NewRouteContext()
	for k, v := range params {
		rctx.URLParams.Add(k, v)
	}
	ctx := context.WithValue(req.Context(), chi.RouteCtxKey, rctx)
	if accountID != "" {
		ctx = WithAccount(ctx, Account{ID: accountID, EmailVerified: true})
	}
	return req.WithContext(ctx)
}

// cloudAccount registers an account and returns its id.
func cloudAccount(t *testing.T, d Deps, email string) string {
	t.Helper()
	registerAccount(t, AccountHandler{Deps: d}, email)
	var id string
	if err := d.DB.QueryRow(`SELECT id FROM accounts WHERE email = ?`, email).Scan(&id); err != nil {
		t.Fatal(err)
	}
	return id
}

// cloudLuna gives an account a Luna on a device it owns.
func cloudLuna(t *testing.T, d Deps, accountID, lunaID, deviceName string) {
	t.Helper()
	devID, _ := mintDevice(t, d, "official")
	if _, err := d.DB.Exec(`UPDATE devices SET account_id = ?, name = ? WHERE id = ?`, accountID, deviceName, devID); err != nil {
		t.Fatal(err)
	}
	if _, err := d.DB.Exec(`INSERT INTO luna_ids (account_id, luna_id, device_id, signing_public, purge_after, created_at)
VALUES (?, ?, ?, '', 0, ?)`, accountID, lunaID, devID, time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
}

// cloudRecord stores one record blob and its index row.
func cloudRecord(t *testing.T, d Deps, accountID, lunaID, kind, name string, data []byte) {
	t.Helper()
	if _, _, err := d.Store.Put(accountID, store.StorageSlot(lunaID), store.StorageRecordPath(kind, name), bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	if _, err := d.DB.Exec(`INSERT INTO storage_records (account_id, luna_id, kind, name, bytes, updated_at, storage_backend)
VALUES (?, ?, ?, ?, ?, ?, 'local')`, accountID, lunaID, kind, name, len(data), time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
}

// cloudPack stores one pack blob and its index row with a scope tag.
func cloudPack(t *testing.T, d Deps, accountID, lunaID, packID, scope string, data []byte) {
	t.Helper()
	if _, _, err := d.Store.Put(accountID, store.StorageSlot(lunaID), store.StoragePackPath(packID), bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	if _, err := d.DB.Exec(`INSERT INTO storage_packs (account_id, luna_id, id, scope, size, created_at, storage_backend)
VALUES (?, ?, ?, ?, ?, ?, 'local')`, accountID, lunaID, packID, scope, len(data), time.Now().Unix()); err != nil {
		t.Fatal(err)
	}
}

func snapshotJSON(prot, tree string) []byte {
	return []byte(`{"record":{"protection_id":"` + prot + `","tree_pack_id":"` + tree + `"}}`)
}

func hexPack(c byte) string { return strings.Repeat(string(c), 64) }

func TestCloudListLunas(t *testing.T) {
	d := testDeps(t)
	owner := cloudAccount(t, d, "owner@example.com")
	other := cloudAccount(t, d, "other@example.com")
	cloudLuna(t, d, owner, "home-luna", "Living room drive")
	cloudLuna(t, d, other, "their-luna", "Their drive")

	h := CloudReadHandler{Deps: d}
	rec := httptest.NewRecorder()
	h.ListLunas(rec, cloudReq(owner, http.MethodGet, "/cloud/lunas", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Lunas []struct {
			LunaID string `json:"luna_id"`
			Name   string `json:"name"`
			Linked bool   `json:"linked"`
		} `json:"lunas"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Lunas) != 1 || got.Lunas[0].LunaID != "home-luna" || got.Lunas[0].Name != "Living room drive" || !got.Lunas[0].Linked {
		t.Fatalf("owner should see only its own Luna, got %+v", got.Lunas)
	}

	empty := cloudAccount(t, d, "empty@example.com")
	rec = httptest.NewRecorder()
	h.ListLunas(rec, cloudReq(empty, http.MethodGet, "/cloud/lunas", nil))
	if !strings.Contains(rec.Body.String(), `"lunas":[]`) {
		t.Fatalf("empty list should encode as [], got %s", rec.Body.String())
	}
}

func TestCloudListLunasNeedsAccount(t *testing.T) {
	d := testDeps(t)
	rec := httptest.NewRecorder()
	CloudReadHandler{Deps: d}.ListLunas(rec, cloudReq("", http.MethodGet, "/cloud/lunas", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("status %d, want 401", rec.Code)
	}
}

func TestCloudListRecords(t *testing.T) {
	d := testDeps(t)
	owner := cloudAccount(t, d, "owner@example.com")
	cloudLuna(t, d, owner, "home-luna", "Drive")
	cloudRecord(t, d, owner, "home-luna", "snapshots", "snap-1.json", snapshotJSON(cloudProtA, hexPack('c')))

	h := CloudReadHandler{Deps: d}
	rec := httptest.NewRecorder()
	h.ListRecords(rec, cloudReq(owner, http.MethodGet, "/cloud/lunas/home-luna/records/snapshots",
		map[string]string{"lunaID": "home-luna", "kind": "snapshots"}))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Records []struct {
			Name string `json:"name"`
			Data string `json:"data"`
		} `json:"records"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Records) != 1 || got.Records[0].Name != "snap-1.json" {
		t.Fatalf("records %+v", got.Records)
	}
	raw, err := base64.StdEncoding.DecodeString(got.Records[0].Data)
	if err != nil || !bytes.Equal(raw, snapshotJSON(cloudProtA, hexPack('c'))) {
		t.Fatalf("record bytes do not match: %v", err)
	}

	empty := cloudAccount(t, d, "empty@example.com")
	rec = httptest.NewRecorder()
	h.ListRecords(rec, cloudReq(empty, http.MethodGet, "/x", map[string]string{"lunaID": "home-luna", "kind": "snapshots"}))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("other account must get 404, got %d", rec.Code)
	}
}

func TestCloudListRecordsNotFound(t *testing.T) {
	d := testDeps(t)
	owner := cloudAccount(t, d, "owner@example.com")
	cloudLuna(t, d, owner, "home-luna", "Drive")
	h := CloudReadHandler{Deps: d}

	cases := map[string]map[string]string{
		"kind not browser-readable": {"lunaID": "home-luna", "kind": "users"},
		"unknown luna":              {"lunaID": "nope", "kind": "snapshots"},
		"bad luna id":               {"lunaID": "Bad_ID!", "kind": "snapshots"},
	}
	for name, params := range cases {
		rec := httptest.NewRecorder()
		h.ListRecords(rec, cloudReq(owner, http.MethodGet, "/x", params))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", name, rec.Code)
		}
	}
}

func TestCloudGetPack(t *testing.T) {
	d := testDeps(t)
	owner := cloudAccount(t, d, "owner@example.com")
	other := cloudAccount(t, d, "other@example.com")
	cloudLuna(t, d, owner, "home-luna", "Drive")
	data := []byte("pack bytes")
	cloudPack(t, d, owner, "home-luna", hexPack('a'), "", data)
	h := CloudReadHandler{Deps: d}

	rec := httptest.NewRecorder()
	h.GetPack(rec, cloudReq(owner, http.MethodGet, "/x", map[string]string{"lunaID": "home-luna", "id": hexPack('a')}))
	if rec.Code != http.StatusOK || !bytes.Equal(rec.Body.Bytes(), data) {
		t.Fatalf("status %d body %q", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Fatalf("content type %q", ct)
	}

	cases := map[string]struct {
		acct   string
		params map[string]string
	}{
		"other account": {other, map[string]string{"lunaID": "home-luna", "id": hexPack('a')}},
		"bad pack id":   {owner, map[string]string{"lunaID": "home-luna", "id": "not-a-pack"}},
		"missing pack":  {owner, map[string]string{"lunaID": "home-luna", "id": hexPack('b')}},
		"unknown luna":  {owner, map[string]string{"lunaID": "nope", "id": hexPack('a')}},
	}
	for name, c := range cases {
		rec := httptest.NewRecorder()
		h.GetPack(rec, cloudReq(c.acct, http.MethodGet, "/x", c.params))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s: status %d, want 404", name, rec.Code)
		}
	}
}

func TestAllowedProtectionsUserScope(t *testing.T) {
	keys := []string{
		cloudProtA + ".1." + cloudUserA, // user A has only the old version of A
		cloudProtA + ".2." + cloudUserB,
		cloudProtB + ".1." + cloudUserA,
	}
	got := allowedProtections(readScope{Kind: "user", Value: cloudUserA}, keys)
	if got == nil || len(got) != 1 || !got[cloudProtB] {
		t.Fatalf("user A should reach only protection B, got %v", got)
	}
	got = allowedProtections(readScope{Kind: "user", Value: cloudUserB}, keys)
	if got == nil || len(got) != 1 || !got[cloudProtA] {
		t.Fatalf("user B should reach only protection A, got %v", got)
	}
	got = allowedProtections(readScope{Kind: "user", Value: cloudUserC}, keys)
	if got == nil || len(got) != 0 {
		t.Fatalf("user with no copy must get a non-nil empty map, got %v", got)
	}
	if allowedProtections(readScope{Kind: ""}, keys) != nil {
		t.Fatal("owner scope must return nil (everything)")
	}
}

func TestFilterRecordsBackupAndSelf(t *testing.T) {
	recs := []storedRecord{
		{Name: "a.json", Data: snapshotJSON(cloudProtA, hexPack('c'))},
		{Name: "b.json", Data: snapshotJSON(cloudProtB, hexPack('8'))},
	}
	s := readScope{Kind: "backup", Value: cloudProtA}
	got := filterRecords(s, "snapshots", recs, nil)
	if len(got) != 1 || got[0].Name != "a.json" {
		t.Fatalf("backup scope should keep only protection A, got %+v", got)
	}

	self := []storedRecord{{Name: "self-1", Data: []byte("sealed")}}
	if got := filterRecords(s, "self", self, nil); len(got) != 1 {
		t.Fatalf("self records should always pass, got %+v", got)
	}

	keyRecs := []storedRecord{
		{Name: cloudProtA + ".1." + cloudUserA},
		{Name: cloudProtB + ".1." + cloudUserA},
	}
	if got := filterRecords(s, "keys", keyRecs, nil); len(got) != 1 || got[0].Name != keyRecs[0].Name {
		t.Fatalf("backup scope keys filter, got %+v", got)
	}
	recipRecs := []storedRecord{{Name: cloudProtA + ".recipient"}, {Name: cloudProtB + ".recipient"}}
	if got := filterRecords(s, "recipients", recipRecs, nil); len(got) != 1 {
		t.Fatalf("backup scope recipients filter, got %+v", got)
	}
}

func TestPackAllowed(t *testing.T) {
	d := testDeps(t)
	owner := cloudAccount(t, d, "owner@example.com")
	cloudLuna(t, d, owner, "home-luna", "Drive")

	// Protection B has its newest key with user A. Its snapshot points at tree pack T with scope "tree-b".
	cloudRecord(t, d, owner, "home-luna", "keys", cloudProtB+".1."+cloudUserA, []byte("k"))
	cloudRecord(t, d, owner, "home-luna", "snapshots", "snap-b.json", snapshotJSON(cloudProtB, hexPack('c')))
	cloudPack(t, d, owner, "home-luna", hexPack('c'), "tree-b", []byte("tree"))
	cloudPack(t, d, owner, "home-luna", hexPack('d'), "tree-b", []byte("data in B"))
	cloudPack(t, d, owner, "home-luna", hexPack('e'), "tree-other", []byte("data elsewhere"))
	cloudPack(t, d, owner, "home-luna", hexPack('f'), "", []byte("untagged"))

	userA := readScope{AccountID: owner, LunaID: "home-luna", Kind: "user", Value: cloudUserA}
	cases := map[string]struct {
		pack string
		want bool
	}{
		"same scope as a visible tree pack": {hexPack('d'), true},
		"different scope":                   {hexPack('e'), false},
		"empty scope tag":                   {hexPack('f'), false},
		"missing pack":                      {hexPack('9'), false},
	}
	for name, c := range cases {
		got, err := packAllowed(d, userA, "", c.pack)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if got != c.want {
			t.Errorf("%s: got %v, want %v", name, got, c.want)
		}
	}

	owned, err := packAllowed(d, readScope{AccountID: owner, LunaID: "home-luna"}, "", hexPack('e'))
	if err != nil || !owned {
		t.Fatalf("owner scope should allow every pack, got %v %v", owned, err)
	}
}

func TestCloudRecordsBodyRead(t *testing.T) {
	// Guards the reader helpers against a blob that exists in the index but not on disk.
	d := testDeps(t)
	owner := cloudAccount(t, d, "owner@example.com")
	cloudLuna(t, d, owner, "home-luna", "Drive")
	if _, err := d.DB.Exec(`INSERT INTO storage_records (account_id, luna_id, kind, name, bytes, updated_at, storage_backend)
VALUES (?, 'home-luna', 'snapshots', 'ghost.json', 1, 0, 'local')`, owner); err != nil {
		t.Fatal(err)
	}
	recs, err := loadRecords(d, readScope{AccountID: owner, LunaID: "home-luna"}, "snapshots")
	if err != nil {
		t.Fatal(err)
	}
	if len(recs) != 0 {
		t.Fatalf("missing blob should be skipped, got %+v", recs)
	}
}

func TestListLunasReportsPurgeAndIgnoresOtherAccountDevice(t *testing.T) {
	d := testDeps(t)
	owner := cloudAccount(t, d, "purge@example.com")
	other := cloudAccount(t, d, "purge-other@example.com")
	cloudLuna(t, d, owner, "home-luna", "Living room drive")
	cloudLuna(t, d, owner, "spare-luna", "Spare drive")
	purgeAt := time.Now().Add(24 * time.Hour).Unix()
	if _, err := d.DB.Exec(`UPDATE luna_ids SET purge_after = ? WHERE account_id = ? AND luna_id = 'spare-luna'`, purgeAt, owner); err != nil {
		t.Fatal(err)
	}
	foreignDev, _ := mintDevice(t, d, "official")
	if _, err := d.DB.Exec(`UPDATE devices SET account_id = ?, name = 'Their drive' WHERE id = ?`, other, foreignDev); err != nil {
		t.Fatal(err)
	}
	if _, err := d.DB.Exec(`UPDATE luna_ids SET device_id = ? WHERE account_id = ? AND luna_id = 'home-luna'`, foreignDev, owner); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	CloudReadHandler{Deps: d}.ListLunas(rec, cloudReq(owner, http.MethodGet, "/cloud/lunas", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Lunas []struct {
			LunaID     string `json:"luna_id"`
			Name       string `json:"name"`
			Linked     bool   `json:"linked"`
			PurgeAfter int64  `json:"purge_after"`
		} `json:"lunas"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	byID := map[string]int{}
	for i, l := range got.Lunas {
		byID[l.LunaID] = i
	}
	home, ok := byID["home-luna"]
	if !ok {
		t.Fatalf("home-luna missing from %+v", got.Lunas)
	}
	if got.Lunas[home].Linked || got.Lunas[home].Name != "" {
		t.Fatalf("device of another account leaked into the list: %+v", got.Lunas[home])
	}
	spare, ok := byID["spare-luna"]
	if !ok {
		t.Fatalf("spare-luna missing from %+v", got.Lunas)
	}
	if got.Lunas[spare].PurgeAfter != purgeAt || !got.Lunas[spare].Linked {
		t.Fatalf("spare-luna %+v, want purge_after %d", got.Lunas[spare], purgeAt)
	}
	if got.Lunas[home].PurgeAfter != 0 {
		t.Fatalf("home-luna purge_after %d, want 0", got.Lunas[home].PurgeAfter)
	}
}

func TestAllowedPackScopesCacheLastsSixtySeconds(t *testing.T) {
	d := testDeps(t)
	owner := cloudAccount(t, d, "cache@example.com")
	cloudLuna(t, d, owner, "home-luna", "Drive")
	cloudRecord(t, d, owner, "home-luna", "keys", cloudProtA+".1."+cloudUserA, []byte("k"))
	cloudRecord(t, d, owner, "home-luna", "snapshots", "snap-a.json", snapshotJSON(cloudProtA, hexPack('c')))
	cloudPack(t, d, owner, "home-luna", hexPack('c'), "tree-a", []byte("tree"))
	userA := readScope{AccountID: owner, LunaID: "home-luna", Kind: "user", Value: cloudUserA}

	const linkID = "cache-test-link"
	packScopeCache.Delete(linkID)
	t0 := time.Now()
	first, err := allowedPackScopes(d, userA, linkID, t0)
	if err != nil {
		t.Fatal(err)
	}
	if !first["tree-a"] {
		t.Fatalf("first scopes %v, want tree-a", first)
	}

	// A new protection becomes visible to user A only after the cache is rebuilt.
	cloudRecord(t, d, owner, "home-luna", "keys", cloudProtB+".1."+cloudUserA, []byte("k"))
	cloudRecord(t, d, owner, "home-luna", "snapshots", "snap-b.json", snapshotJSON(cloudProtB, hexPack('e')))
	cloudPack(t, d, owner, "home-luna", hexPack('e'), "tree-b", []byte("tree b"))

	within, err := allowedPackScopes(d, userA, linkID, t0.Add(30*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if within["tree-b"] {
		t.Fatal("cache should still serve the old scopes at 30 s")
	}
	after, err := allowedPackScopes(d, userA, linkID, t0.Add(61*time.Second))
	if err != nil {
		t.Fatal(err)
	}
	if !after["tree-b"] {
		t.Fatalf("cache should rebuild after 60 s, got %v", after)
	}
}

func TestListLunasReportsZeroForPurgeInProgress(t *testing.T) {
	d := testDeps(t)
	owner := cloudAccount(t, d, "claimed@example.com")
	cloudLuna(t, d, owner, "claimed-luna", "Claimed drive")
	if _, err := d.DB.Exec(`UPDATE luna_ids SET purge_after = -1 WHERE account_id = ? AND luna_id = 'claimed-luna'`, owner); err != nil {
		t.Fatal(err)
	}

	rec := httptest.NewRecorder()
	CloudReadHandler{Deps: d}.ListLunas(rec, cloudReq(owner, http.MethodGet, "/cloud/lunas", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var got struct {
		Lunas []struct {
			LunaID     string `json:"luna_id"`
			PurgeAfter int64  `json:"purge_after"`
		} `json:"lunas"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Lunas) != 1 {
		t.Fatalf("lunas %+v, want one", got.Lunas)
	}
	if got.Lunas[0].PurgeAfter != 0 {
		t.Fatalf("purge_after %d for a purge in progress, want 0", got.Lunas[0].PurgeAfter)
	}
}
