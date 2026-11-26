package handlers

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
)

type storageRelinkFixture struct {
	deps     Deps
	acctH    AccountHandler
	devH     DeviceHandler
	cookieA  *http.Cookie
	cookieB  *http.Cookie
	uid      string
	oldToken string
}

func newStorageRelinkFixture(t *testing.T, name string) storageRelinkFixture {
	t.Helper()
	d := testDeps(t)
	acctH := AccountHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	cookieA := registerAccount(t, acctH, name+"-a@s.co")
	cookieB := registerAccount(t, acctH, name+"-b@s.co")
	verifyEmailFor(t, acctH, name+"-a@s.co")
	verifyEmailFor(t, acctH, name+"-b@s.co")
	_, _ = d.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'active'`)
	_, uid := mintDevice(t, d, "official")
	_, oldToken := pairDeviceForAccount(t, acctH, devH, cookieA, uid)
	return storageRelinkFixture{
		deps: d, acctH: acctH, devH: devH, cookieA: cookieA, cookieB: cookieB,
		uid: uid, oldToken: oldToken,
	}
}

func (f storageRelinkFixture) relink(t *testing.T) string {
	t.Helper()
	dev, err := loadDeviceByAuthToken(f.deps.DB, f.oldToken)
	if err != nil {
		t.Fatal(err)
	}
	if err := unbindDevice(f.deps, dev, dev.AccountID.String); err != nil {
		t.Fatal(err)
	}
	_, token := pairDeviceForAccount(t, f.acctH, f.devH, f.cookieB, f.uid)
	return token
}

func (f storageRelinkFixture) putRecord(t *testing.T, token, name, value string) *httptest.ResponseRecorder {
	t.Helper()
	return storageDo(t, storageRouter(f.deps), http.MethodPut, "/records/snapshots/"+name, token, "shared", []byte(value), nil)
}

func TestStorageReadRejectsBearerAdmittedBeforeRelink(t *testing.T) {
	f := newStorageRelinkFixture(t, "stale-read")
	if rec := f.putRecord(t, f.oldToken, "secret.json", "old-secret"); rec.Code != http.StatusOK {
		t.Fatalf("seed old record %d %s", rec.Code, rec.Body.String())
	}
	stor := StorageHandler{Deps: f.deps}
	handler := f.devH.DeviceAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		newToken := f.relink(t)
		if rec := f.putRecord(t, newToken, "secret.json", "new-account-secret"); rec.Code != http.StatusOK {
			t.Fatalf("seed replacement record %d %s", rec.Code, rec.Body.String())
		}
		stor.GetRecord(w, r)
	}))
	rec := storageDo(t, handler, http.MethodGet, "/records/snapshots/secret.json", f.oldToken, "shared", nil, nil)
	if rec.Code != http.StatusUnauthorized || strings.Contains(rec.Body.String(), "new-account-secret") {
		t.Fatalf("stale bearer read replacement data: %d %s", rec.Code, rec.Body.String())
	}
}

func TestStorageRecordBodyIsRecheckedBeforeFinalCommit(t *testing.T) {
	f := newStorageRelinkFixture(t, "stale-record-put")
	if rec := f.putRecord(t, f.oldToken, "secret.json", "old-secret"); rec.Code != http.StatusOK {
		t.Fatalf("seed old record %d %s", rec.Code, rec.Body.String())
	}
	stor := StorageHandler{Deps: f.deps}
	var replacementToken string
	// Mount the real route so PutRecord gets its path parameters; DeviceAuth
	// admits the old credential, then the handler body relinks before the
	// body recheck runs.
	router := chi.NewRouter()
	router.With(f.devH.DeviceAuth).Put("/storage/records/{kind}/{name}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		replacementToken = f.relink(t)
		if rec := f.putRecord(t, replacementToken, "secret.json", "new-account-secret"); rec.Code != http.StatusOK {
			t.Fatalf("seed replacement record %d %s", rec.Code, rec.Body.String())
		}
		stor.PutRecord(w, r)
	}))
	rec := storageDo(t, router, http.MethodPut, "/records/snapshots/secret.json", f.oldToken, "shared", []byte("attacker"), nil)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("stale record write %d %s", rec.Code, rec.Body.String())
	}
	// The fixture is already relinked, so read through the replacement credential.
	read := storageDo(t, storageRouter(f.deps), http.MethodGet, "/records/snapshots/secret.json", replacementToken, "shared", nil, nil)
	if read.Code != http.StatusOK || read.Body.String() != "new-account-secret" {
		t.Fatalf("replacement record changed: %d %q", read.Code, read.Body.String())
	}
}

func TestSigningPublicRejectsBearerAdmittedBeforeRelink(t *testing.T) {
	f := newStorageRelinkFixture(t, "stale-signing")
	first := newHybridKey(t).pubHex()
	second := newHybridKey(t).pubHex()
	stor := StorageHandler{Deps: f.deps}
	router := chi.NewRouter()
	router.With(f.devH.DeviceAuth).Post("/storage/luna-ids/{id}/signing-public", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		newToken := f.relink(t)
		seed := storageDo(t, storageRouter(f.deps), http.MethodPut, "/records/identity/public", newToken, "shared", []byte(first), nil)
		if seed.Code != http.StatusOK {
			t.Fatalf("seed replacement signing key %d %s", seed.Code, seed.Body.String())
		}
		stor.SetSigningPublic(w, r)
	}))
	req := storageDo(t, router, http.MethodPost, "/luna-ids/shared/signing-public", f.oldToken, "", []byte(second), nil)
	if req.Code != http.StatusUnauthorized {
		t.Fatalf("stale signing write %d %s", req.Code, req.Body.String())
	}
	var key string
	if err := f.deps.DB.QueryRow(`SELECT signing_public FROM luna_ids WHERE luna_id = 'shared'`).Scan(&key); err != nil {
		t.Fatal(err)
	}
	if key != first {
		t.Fatalf("replacement signing key changed: %q", key)
	}
}

type gatedPackBody struct {
	data    []byte
	started chan struct{}
	release chan struct{}
	once    sync.Once
}

func (b *gatedPackBody) Read(p []byte) (int, error) {
	b.once.Do(func() {
		close(b.started)
		<-b.release
	})
	if len(b.data) == 0 {
		return 0, io.EOF
	}
	n := copy(p, b.data)
	b.data = b.data[n:]
	return n, nil
}

func TestPackUploadRechecksCredentialAfterBodySpooling(t *testing.T) {
	f := newStorageRelinkFixture(t, "stale-pack")
	body := []byte("pack-admitted-before-relink")
	sum := sha256.Sum256(body)
	id := hex.EncodeToString(sum[:])
	gated := &gatedPackBody{data: body, started: make(chan struct{}), release: make(chan struct{})}
	req := httptest.NewRequest(http.MethodPut, "/storage/packs/"+id, gated)
	req.Header.Set("Authorization", "Bearer "+f.oldToken)
	req.Header.Set("X-Luna-Id", "shared")
	rec := httptest.NewRecorder()
	done := make(chan struct{})
	go func() {
		storageRouter(f.deps).ServeHTTP(rec, req)
		close(done)
	}()
	select {
	case <-gated.started:
	case <-time.After(2 * time.Second):
		t.Fatal("pack upload did not start spooling")
	}
	release := sync.Once{}
	releaseBody := func() { release.Do(func() { close(gated.release) }) }
	defer releaseBody()
	f.relink(t)
	releaseBody()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("pack upload did not finish")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("stale pack upload %d %s", rec.Code, rec.Body.String())
	}
	var rows int
	if err := f.deps.DB.QueryRow(`SELECT COUNT(*) FROM storage_packs WHERE id = ?`, id).Scan(&rows); err != nil {
		t.Fatal(err)
	}
	if rows != 0 {
		t.Fatalf("stale pack upload recorded %d rows", rows)
	}
	var claimed int
	if err := f.deps.DB.QueryRow(`SELECT COUNT(*) FROM luna_ids WHERE luna_id = 'shared'`).Scan(&claimed); err != nil {
		t.Fatal(err)
	}
	if claimed != 0 {
		t.Fatalf("stale pack upload claimed %d Luna IDs", claimed)
	}
}
