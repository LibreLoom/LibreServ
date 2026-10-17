package handlers

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

// shareFixture makes an owner account with one Luna named "Living room drive".
func shareFixture(t *testing.T) (Deps, string) {
	t.Helper()
	d := testDeps(t)
	owner := cloudAccount(t, d, "owner@example.com")
	cloudLuna(t, d, owner, "home-luna", "Living room drive")
	return d, owner
}

// shareReq is cloudReq with a body and an optional X-Share-Token header.
func shareReq(accountID, method, target, body string, params map[string]string, token string) *http.Request {
	req := cloudReq(accountID, method, target, params)
	req.Body = io.NopCloser(strings.NewReader(body))
	if token != "" {
		req.Header.Set(shareTokenHeader, token)
	}
	return req
}

func shareBody(kind, value string) string {
	return `{"luna_id":"home-luna","scope_kind":"` + kind + `","scope_value":"` + value + `"}`
}

// createShare makes a link and returns its id and token, failing the test on any error.
func createShare(t *testing.T, d Deps, accountID, body string) (string, string) {
	t.Helper()
	rec := httptest.NewRecorder()
	ShareLinkHandler{Deps: d}.Create(rec, shareReq(accountID, http.MethodPost, "/x", body, nil, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("create status %d: %s", rec.Code, rec.Body.String())
	}
	var got struct {
		ID    string `json:"id"`
		Token string `json:"token"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	return got.ID, got.Token
}

func fetchShareInfo(d Deps, token string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	ShareLinkHandler{Deps: d}.Info(rec, shareReq("", http.MethodGet, "/api/v1/share", "", nil, token))
	return rec
}

func TestShareCreateStoresOnlyHash(t *testing.T) {
	d, owner := shareFixture(t)
	id, token := createShare(t, d, owner, shareBody("user", cloudUserA))

	if len(token) != 43 {
		t.Fatalf("token length %d, want 43", len(token))
	}
	var hash string
	if err := d.DB.QueryRow(`SELECT token_hash FROM share_links WHERE id = ?`, id).Scan(&hash); err != nil {
		t.Fatal(err)
	}
	if hash != security.HashToken(token) || len(hash) != 64 || hash == token {
		t.Fatalf("stored hash %q is not sha256 of the token", hash)
	}
}

func TestShareInfoShowsLunaAndSender(t *testing.T) {
	d, owner := shareFixture(t)
	id, token := createShare(t, d, owner, shareBody("user", cloudUserA))

	rec := fetchShareInfo(d, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("cache-control %q, want no-store", cc)
	}
	var got struct {
		LunaID   string `json:"luna_id"`
		LunaName string `json:"luna_name"`
		SentBy   string `json:"sent_by"`
		Scope    struct {
			Kind  string `json:"kind"`
			Value string `json:"value"`
		} `json:"scope"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.LunaID != "home-luna" || got.LunaName != "Living room drive" || got.SentBy != "owner@example.com" {
		t.Fatalf("info %+v", got)
	}
	if got.Scope.Kind != "user" || got.Scope.Value != cloudUserA {
		t.Fatalf("scope %+v", got.Scope)
	}

	var opened int64
	if err := d.DB.QueryRow(`SELECT last_opened_at FROM share_links WHERE id = ?`, id).Scan(&opened); err != nil {
		t.Fatal(err)
	}
	if opened == 0 {
		t.Fatal("opening the link did not set last_opened_at")
	}
}

func TestShareDeadLinksGetSameNotFound(t *testing.T) {
	d, owner := shareFixture(t)

	_, expiredTok := createShare(t, d, owner, shareBody("user", cloudUserA))
	expiredID := ""
	if err := d.DB.QueryRow(`SELECT id FROM share_links WHERE token_hash = ?`, security.HashToken(expiredTok)).Scan(&expiredID); err != nil {
		t.Fatal(err)
	}
	if _, err := d.DB.Exec(`UPDATE share_links SET expires_at = ? WHERE id = ?`, time.Now().Add(-time.Hour).Unix(), expiredID); err != nil {
		t.Fatal(err)
	}

	revokedID, revokedTok := createShare(t, d, owner, shareBody("user", cloudUserB))
	rec := httptest.NewRecorder()
	ShareLinkHandler{Deps: d}.Revoke(rec, shareReq(owner, http.MethodDelete, "/x", "", map[string]string{"id": revokedID}, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke status %d: %s", rec.Code, rec.Body.String())
	}

	unknownTok := strings.Repeat("x", 43)
	var want string
	for name, tok := range map[string]string{"expired": expiredTok, "revoked": revokedTok, "unknown": unknownTok} {
		rec := fetchShareInfo(d, tok)
		if rec.Code != http.StatusNotFound {
			t.Fatalf("%s: status %d, want 404", name, rec.Code)
		}
		if want == "" {
			want = rec.Body.String()
		} else if rec.Body.String() != want {
			t.Fatalf("%s: body %q differs from %q", name, rec.Body.String(), want)
		}
	}
	if !strings.Contains(want, shareGoneMessage) {
		t.Fatalf("404 body %q lacks the shared message", want)
	}
}

func TestShareRevokeOnlyOwnAccount(t *testing.T) {
	d, owner := shareFixture(t)
	other := cloudAccount(t, d, "other@example.com")
	id, token := createShare(t, d, owner, shareBody("user", cloudUserA))

	rec := httptest.NewRecorder()
	ShareLinkHandler{Deps: d}.Revoke(rec, shareReq(other, http.MethodDelete, "/x", "", map[string]string{"id": id}, ""))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("other account revoke status %d, want 404", rec.Code)
	}
	if rec := fetchShareInfo(d, token); rec.Code != http.StatusOK {
		t.Fatalf("link died after another account's revoke: status %d", rec.Code)
	}
}

func TestShareLimitOf20Active(t *testing.T) {
	d, owner := shareFixture(t)
	var firstID string
	for i := 0; i < maxActiveShareLinks; i++ {
		id, _ := createShare(t, d, owner, shareBody("user", cloudUserA))
		if i == 0 {
			firstID = id
		}
	}
	rec := httptest.NewRecorder()
	ShareLinkHandler{Deps: d}.Create(rec, shareReq(owner, http.MethodPost, "/x", shareBody("user", cloudUserA), nil, ""))
	if rec.Code != http.StatusConflict {
		t.Fatalf("21st link status %d, want 409", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), shareLimitMessage) {
		t.Fatalf("409 body %q", rec.Body.String())
	}

	rec = httptest.NewRecorder()
	ShareLinkHandler{Deps: d}.Revoke(rec, shareReq(owner, http.MethodDelete, "/x", "", map[string]string{"id": firstID}, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("revoke status %d", rec.Code)
	}
	createShare(t, d, owner, shareBody("user", cloudUserA))
}

func TestShareRecordsAndPacksFollowScope(t *testing.T) {
	d, owner := shareFixture(t)
	// Protection A belongs to user A. Protection B belongs to user B.
	cloudRecord(t, d, owner, "home-luna", "keys", cloudProtA+".1."+cloudUserA, []byte("key a"))
	cloudRecord(t, d, owner, "home-luna", "keys", cloudProtB+".1."+cloudUserB, []byte("key b"))
	cloudRecord(t, d, owner, "home-luna", "snapshots", "snap-a.json", snapshotJSON(cloudProtA, hexPack('c')))
	cloudRecord(t, d, owner, "home-luna", "snapshots", "snap-b.json", snapshotJSON(cloudProtB, hexPack('e')))
	cloudPack(t, d, owner, "home-luna", hexPack('c'), "tagA", []byte("tree a"))
	cloudPack(t, d, owner, "home-luna", hexPack('d'), "tagA", []byte("data a"))
	cloudPack(t, d, owner, "home-luna", hexPack('e'), "tagB", []byte("tree b"))

	h := ShareLinkHandler{Deps: d}
	recordNamesFor := func(token string) []string {
		rec := httptest.NewRecorder()
		h.Records(rec, shareReq("", http.MethodGet, "/x", "", map[string]string{"kind": "snapshots"}, token))
		if rec.Code != http.StatusOK {
			t.Fatalf("records status %d: %s", rec.Code, rec.Body.String())
		}
		var got struct {
			Records []struct {
				Name string `json:"name"`
			} `json:"records"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
			t.Fatal(err)
		}
		names := make([]string, 0, len(got.Records))
		for _, r := range got.Records {
			names = append(names, r.Name)
		}
		return names
	}
	packStatus := func(token, packID string) (int, string) {
		rec := httptest.NewRecorder()
		h.Pack(rec, shareReq("", http.MethodGet, "/x", "", map[string]string{"id": packID}, token))
		return rec.Code, rec.Body.String()
	}

	_, userTok := createShare(t, d, owner, shareBody("user", cloudUserA))
	if names := recordNamesFor(userTok); len(names) != 1 || names[0] != "snap-a.json" {
		t.Fatalf("user A link records %v, want only snap-a.json", names)
	}
	if code, body := packStatus(userTok, hexPack('c')); code != http.StatusOK || body != "tree a" {
		t.Fatalf("user A link, tree pack A: status %d body %q", code, body)
	}
	if code, _ := packStatus(userTok, hexPack('e')); code != http.StatusNotFound {
		t.Fatalf("user A link, pack of protection B: status %d, want 404", code)
	}

	_, backupTok := createShare(t, d, owner, shareBody("backup", cloudProtA))
	if names := recordNamesFor(backupTok); len(names) != 1 || names[0] != "snap-a.json" {
		t.Fatalf("backup A link records %v, want only snap-a.json", names)
	}
	if code, body := packStatus(backupTok, hexPack('d')); code != http.StatusOK || body != "data a" {
		t.Fatalf("backup A link, data pack: status %d body %q", code, body)
	}
	if code, _ := packStatus(backupTok, hexPack('e')); code != http.StatusNotFound {
		t.Fatalf("backup A link, pack of other scope: status %d, want 404", code)
	}
}

func TestShareCreateRejectsBadScope(t *testing.T) {
	d, owner := shareFixture(t)
	h := ShareLinkHandler{Deps: d}
	cases := map[string]string{
		"unknown kind":          shareBody("owner", cloudUserA),
		"upper-case user hex":   shareBody("user", strings.ToUpper(cloudUserA)),
		"short user value":      shareBody("user", cloudUserA[:31]),
		"backup with bad chars": shareBody("backup", "Bad_ID!"),
		"backup too long":       shareBody("backup", strings.Repeat("a", 65)),
		"empty backup value":    shareBody("backup", ""),
		"not json":              `{"luna_id":`,
	}
	for name, body := range cases {
		rec := httptest.NewRecorder()
		h.Create(rec, shareReq(owner, http.MethodPost, "/x", body, nil, ""))
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: status %d, want 400", name, rec.Code)
		}
	}

	rec := httptest.NewRecorder()
	h.Create(rec, shareReq(owner, http.MethodPost, "/x", shareBody("user", cloudUserA), nil, ""))
	if rec.Code != http.StatusOK {
		t.Fatalf("valid body status %d", rec.Code)
	}
	if !bytes.Contains(rec.Body.Bytes(), []byte(`"token"`)) {
		t.Fatalf("valid body answer %s", rec.Body.String())
	}
}

// cutOffWriter accepts limit bytes and then fails, like a client that went away mid-download.
type cutOffWriter struct {
	header       http.Header
	limit, wrote int
}

func (w *cutOffWriter) Header() http.Header { return w.header }
func (w *cutOffWriter) WriteHeader(int)     {}
func (w *cutOffWriter) Write(p []byte) (int, error) {
	room := w.limit - w.wrote
	if len(p) <= room {
		w.wrote += len(p)
		return len(p), nil
	}
	w.wrote += room
	return room, errors.New("client went away")
}

func TestShareEgressRecordedAndCapped(t *testing.T) {
	d, owner := shareFixture(t)
	cloudRecord(t, d, owner, "home-luna", "keys", cloudProtA+".1."+cloudUserA, []byte("key a"))
	cloudRecord(t, d, owner, "home-luna", "snapshots", "snap-a.json", snapshotJSON(cloudProtA, hexPack('c')))
	cloudPack(t, d, owner, "home-luna", hexPack('c'), "tagA", []byte("tree a"))
	id, token := createShare(t, d, owner, shareBody("user", cloudUserA))
	h := ShareLinkHandler{Deps: d}
	packGet := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.Pack(rec, shareReq("", http.MethodGet, "/x", "", map[string]string{"id": hexPack('c')}, token))
		return rec
	}

	if rec := packGet(); rec.Code != http.StatusOK || rec.Body.String() != "tree a" {
		t.Fatalf("pack status %d body %q", rec.Code, rec.Body.String())
	}
	var used int64
	if err := d.DB.QueryRow(`SELECT egress_bytes FROM share_links WHERE id = ?`, id).Scan(&used); err != nil {
		t.Fatal(err)
	}
	if used != 6 {
		t.Fatalf("egress_bytes %d, want 6", used)
	}

	limit, err := shareEgressCap(d, owner, "home-luna")
	if err != nil {
		t.Fatal(err)
	}
	if limit != 18 {
		t.Fatalf("cap %d, want 3 x 6 = 18", limit)
	}
	if _, err := d.DB.Exec(`UPDATE share_links SET egress_bytes = ? WHERE id = ?`, limit, id); err != nil {
		t.Fatal(err)
	}
	if rec := packGet(); rec.Code != http.StatusTooManyRequests || !strings.Contains(rec.Body.String(), shareEgressMessage) {
		t.Fatalf("over cap: status %d body %q", rec.Code, rec.Body.String())
	}
}

func TestShareEgressFallbackCapWithoutStoredPacks(t *testing.T) {
	d, owner := shareFixture(t) // home-luna has no packs, so the 2 TB fallback applies
	id, token := createShare(t, d, owner, shareBody("user", cloudUserA))
	limit, err := shareEgressCap(d, owner, "home-luna")
	if err != nil {
		t.Fatal(err)
	}
	if limit != shareEgressFallbackCap {
		t.Fatalf("cap %d, want fallback %d", limit, shareEgressFallbackCap)
	}
	h := ShareLinkHandler{Deps: d}
	packGet := func() *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		h.Pack(rec, shareReq("", http.MethodGet, "/x", "", map[string]string{"id": hexPack('c')}, token))
		return rec
	}
	if _, err := d.DB.Exec(`UPDATE share_links SET egress_bytes = ? WHERE id = ?`, shareEgressFallbackCap-1, id); err != nil {
		t.Fatal(err)
	}
	if rec := packGet(); rec.Code == http.StatusTooManyRequests {
		t.Fatal("just under the fallback cap should not be refused")
	}
	if _, err := d.DB.Exec(`UPDATE share_links SET egress_bytes = ? WHERE id = ?`, shareEgressFallbackCap, id); err != nil {
		t.Fatal(err)
	}
	if rec := packGet(); rec.Code != http.StatusTooManyRequests {
		t.Fatalf("at the fallback cap: status %d, want 429", rec.Code)
	}
}

func TestShareEgressRecordedWhenClientStopsEarly(t *testing.T) {
	d, owner := shareFixture(t)
	cloudRecord(t, d, owner, "home-luna", "keys", cloudProtA+".1."+cloudUserA, []byte("key a"))
	cloudRecord(t, d, owner, "home-luna", "snapshots", "snap-a.json", snapshotJSON(cloudProtA, hexPack('c')))
	cloudPack(t, d, owner, "home-luna", hexPack('c'), "tagA", []byte("tree a"))
	id, token := createShare(t, d, owner, shareBody("user", cloudUserA))

	w := &cutOffWriter{header: http.Header{}, limit: 3}
	ShareLinkHandler{Deps: d}.Pack(w, shareReq("", http.MethodGet, "/x", "", map[string]string{"id": hexPack('c')}, token))
	if w.wrote != 3 {
		t.Fatalf("wrote %d bytes, want 3", w.wrote)
	}
	var used int64
	if err := d.DB.QueryRow(`SELECT egress_bytes FROM share_links WHERE id = ?`, id).Scan(&used); err != nil {
		t.Fatal(err)
	}
	if used != 3 {
		t.Fatalf("link egress %d, want the 3 bytes that were written", used)
	}
	var billed int64
	if err := d.DB.QueryRow(`SELECT COALESCE(SUM(egress_bytes), 0) FROM billing_period_egress WHERE account_id = ?`, owner).Scan(&billed); err != nil {
		t.Fatal(err)
	}
	if billed != 3 {
		t.Fatalf("billed egress %d, want 3", billed)
	}
}

func TestInfoIgnoresDeviceOfAnotherAccount(t *testing.T) {
	d, owner := shareFixture(t)
	other := cloudAccount(t, d, "elsewhere@example.com")
	foreignDev, _ := mintDevice(t, d, "official")
	if _, err := d.DB.Exec(`UPDATE devices SET account_id = ?, name = 'Their drive' WHERE id = ?`, other, foreignDev); err != nil {
		t.Fatal(err)
	}
	if _, err := d.DB.Exec(`UPDATE luna_ids SET device_id = ? WHERE account_id = ? AND luna_id = 'home-luna'`, foreignDev, owner); err != nil {
		t.Fatal(err)
	}
	_, token := createShare(t, d, owner, shareBody("user", cloudUserA))
	rec := fetchShareInfo(d, token)
	if rec.Code != http.StatusOK {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	var got struct {
		LunaName string `json:"luna_name"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.LunaName != "" {
		t.Fatalf("luna_name %q leaked from another account's device", got.LunaName)
	}
}
