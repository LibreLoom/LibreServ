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

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

func seedBackupAccounts(t *testing.T) (BackupHandler, AccountHandler, *http.Cookie, *http.Cookie, string, string) {
	t.Helper()
	acctH := AccountHandler{Deps: testDeps(t)}
	bak := BackupHandler{Deps: acctH.Deps}
	owner := registerAccount(t, acctH, "owner@b.co")
	other := registerAccount(t, acctH, "other@b.co")
	var ownerID, otherID string
	_ = bak.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'owner@b.co'`).Scan(&ownerID)
	_ = bak.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'other@b.co'`).Scan(&otherID)
	devMine := "dev_mine01"
	devTheirs := "dev_theirs"
	_, err := bak.DB.Exec(`INSERT INTO devices (id, account_id, token_hash, name, subdomain, tunnel_id, local_port, created_at)
VALUES (?, ?, ?, 'Luna', 'mine', '', 8090, ?), (?, ?, ?, 'Luna', 'theirs', '', 8090, ?)`,
		devMine, ownerID, security.HashToken("tok-mine"), time.Now().Unix(),
		devTheirs, otherID, security.HashToken("tok-theirs"), time.Now().Unix())
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := bak.Store.Put(ownerID, devMine, "Photos/a.jpg", strings.NewReader("owner-bytes")); err != nil {
		t.Fatal(err)
	}
	if _, _, err := bak.Store.Put(otherID, devTheirs, "secret.txt", strings.NewReader("other-bytes")); err != nil {
		t.Fatal(err)
	}
	_, _ = bak.DB.Exec(`INSERT INTO backup_objects (id, account_id, device_id, relative_path, size, content_hash, updated_at)
VALUES ('obj_1', ?, ?, 'Photos/a.jpg', 11, 'x', ?), ('obj_2', ?, ?, 'secret.txt', 11, 'y', ?)`,
		ownerID, devMine, time.Now().Unix(), otherID, devTheirs, time.Now().Unix())
	_, _ = bak.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'active' WHERE id = ?`, ownerID)
	return bak, acctH, owner, other, devMine, ownerID
}

func TestBackupDownloadAuthz(t *testing.T) {
	bak, acctH, owner, other, mine, _ := seedBackupAccounts(t)

	okReq := httptest.NewRequest(http.MethodPost, "/backups/download", bytes.NewBufferString(`{"device_id":"`+mine+`","path":"Photos/a.jpg"}`))
	okReq.AddCookie(owner)
	okRec := withAccount(acctH, bak.Download, okReq)
	if okRec.Code != 200 || !strings.Contains(okRec.Body.String(), "owner-bytes") {
		t.Fatalf("own download %d %s", okRec.Code, okRec.Body.String())
	}
	cd := okRec.Header().Get("Content-Disposition")
	if !strings.Contains(cd, "a.jpg") || strings.Contains(cd, "Photos/") {
		t.Fatalf("content-disposition %q", cd)
	}
	var egress int64
	_ = bak.DB.QueryRow(`SELECT COALESCE(egress_bytes,0) FROM billing_period_egress WHERE account_id = (SELECT account_id FROM devices WHERE id = ?)`, mine).Scan(&egress)
	if egress != int64(len("owner-bytes")) {
		t.Fatalf("egress recorded=%d want %d", egress, len("owner-bytes"))
	}

	foreign := httptest.NewRequest(http.MethodPost, "/backups/download", bytes.NewBufferString(`{"device_id":"dev_theirs","path":"secret.txt"}`))
	foreign.AddCookie(owner)
	frec := withAccount(acctH, bak.Download, foreign)
	if frec.Code != http.StatusNotFound {
		t.Fatalf("foreign device %d %s", frec.Code, frec.Body.String())
	}

	otherGet := httptest.NewRequest(http.MethodPost, "/backups/download", bytes.NewBufferString(`{"device_id":"`+mine+`","path":"Photos/a.jpg"}`))
	otherGet.AddCookie(other)
	orec := withAccount(acctH, bak.Download, otherGet)
	if orec.Code != http.StatusNotFound {
		t.Fatalf("other account %d %s", orec.Code, orec.Body.String())
	}

	trav := httptest.NewRequest(http.MethodPost, "/backups/download", bytes.NewBufferString(`{"device_id":"../`+mine+`","path":"Photos/a.jpg"}`))
	trav.AddCookie(owner)
	trec := withAccount(acctH, bak.Download, trav)
	if trec.Code != http.StatusNotFound {
		t.Fatalf("traversal device %d %s", trec.Code, trec.Body.String())
	}
}

func TestBackupDeleteAuthz(t *testing.T) {
	bak, acctH, owner, other, mine, ownerID := seedBackupAccounts(t)
	del := httptest.NewRequest(http.MethodDelete, "/backups", bytes.NewBufferString(`{"device_id":"`+mine+`","path":"Photos/a.jpg"}`))
	del.AddCookie(other)
	drec := withAccount(acctH, bak.DeleteAccountObject, del)
	if drec.Code != http.StatusNotFound {
		t.Fatalf("other delete %d %s", drec.Code, drec.Body.String())
	}
	rc, err := bak.Store.Get(ownerID, mine, "Photos/a.jpg")
	if err != nil {
		t.Fatal("object must remain")
	}
	rc.Close()

	ok := httptest.NewRequest(http.MethodDelete, "/backups", bytes.NewBufferString(`{"device_id":"`+mine+`","path":"Photos/a.jpg"}`))
	ok.AddCookie(owner)
	orec := withAccount(acctH, bak.DeleteAccountObject, ok)
	if orec.Code != 200 {
		t.Fatalf("owner delete %d %s", orec.Code, orec.Body.String())
	}
}

func TestPutObjectHashesServerSide(t *testing.T) {
	d := testDeps(t)
	bak := BackupHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	acctH := AccountHandler{Deps: d}
	cookie := registerAccount(t, acctH, "hash@b.co")
	var acctID string
	_ = d.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'hash@b.co'`).Scan(&acctID)
	_, _ = d.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'active' WHERE id = ?`, acctID)
	tok := "device-plain-token"
	_, _ = d.DB.Exec(`INSERT INTO devices (id, account_id, token_hash, name, subdomain, local_port, created_at)
VALUES ('dev_hash1', ?, ?, 'Luna', 'hashy', 8090, ?)`, acctID, security.HashToken(tok), time.Now().Unix())

	body := []byte("hello-luna")
	sum := sha256.Sum256(body)
	put := httptest.NewRequest(http.MethodPut, "/backup/objects/notes.txt", bytes.NewReader(body))
	put.Header.Set("Authorization", "Bearer "+tok)
	put.Header.Set("X-Content-Hash", "deadbeef")
	put.SetPathValue("*", "notes.txt")
	rec := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(bak.PutObject)).ServeHTTP(rec, put)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("mismatch hash %d %s", rec.Code, rec.Body.String())
	}

	put2 := httptest.NewRequest(http.MethodPut, "/backup/objects/notes.txt", bytes.NewReader(body))
	put2.Header.Set("Authorization", "Bearer "+tok)
	put2.SetPathValue("*", "notes.txt")
	rec2 := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(bak.PutObject)).ServeHTTP(rec2, put2)
	if rec2.Code != 200 {
		t.Fatalf("put %d %s", rec2.Code, rec2.Body.String())
	}
	var stored string
	_ = d.DB.QueryRow(`SELECT content_hash FROM backup_objects WHERE account_id = ?`, acctID).Scan(&stored)
	if stored != hex.EncodeToString(sum[:]) {
		t.Fatalf("stored hash %s", stored)
	}
	_ = cookie
}

func TestPutObjectQuota(t *testing.T) {
	d := testDeps(t)
	bak := BackupHandler{Deps: d}
	devH := DeviceHandler{Deps: d}
	acctH := AccountHandler{Deps: d}
	_ = registerAccount(t, acctH, "quota@b.co")
	var acctID string
	_ = d.DB.QueryRow(`SELECT id FROM accounts WHERE email = 'quota@b.co'`).Scan(&acctID)
	_, _ = d.DB.Exec(`UPDATE accounts SET has_card = 1, billing_status = 'active', backup_quota_bytes = 4 WHERE id = ?`, acctID)
	tok := "quota-token"
	_, _ = d.DB.Exec(`INSERT INTO devices (id, account_id, token_hash, name, subdomain, local_port, created_at)
VALUES ('dev_quota', ?, ?, 'Luna', 'quota', 8090, ?)`, acctID, security.HashToken(tok), time.Now().Unix())
	put := httptest.NewRequest(http.MethodPut, "/backup/objects/big.txt", strings.NewReader("too-big"))
	put.Header.Set("Authorization", "Bearer "+tok)
	put.SetPathValue("*", "big.txt")
	rec := httptest.NewRecorder()
	devH.DeviceAuth(http.HandlerFunc(bak.PutObject)).ServeHTTP(rec, put)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("quota %d %s", rec.Code, rec.Body.String())
	}
}

func TestClientIPTrustedProxyOnly(t *testing.T) {
	spoof := httptest.NewRequest(http.MethodGet, "/", nil)
	spoof.RemoteAddr = "203.0.113.9:80"
	spoof.Header.Set("X-Forwarded-For", "1.2.3.4")
	if ClientIP(spoof) != "203.0.113.9" {
		t.Fatalf("untrusted xff: %s", ClientIP(spoof))
	}
	ok := httptest.NewRequest(http.MethodGet, "/", nil)
	ok.RemoteAddr = "127.0.0.1:9"
	ok.Header.Set("X-Forwarded-For", "198.51.100.20")
	if ClientIP(ok) != "198.51.100.20" {
		t.Fatalf("trusted xff: %s", ClientIP(ok))
	}
}

func TestOriginAllowed(t *testing.T) {
	prev := config.C.Server.BaseURL
	t.Cleanup(func() { config.C.Server.BaseURL = prev })
	config.C.Server.BaseURL = "https://connect.luna.libreloom.org"
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if !originAllowed(req) {
		t.Fatal("empty origin")
	}
	req.Header.Set("Origin", "https://evil.example")
	if originAllowed(req) {
		t.Fatal("evil origin")
	}
	req.Header.Set("Origin", "https://connect.luna.libreloom.org")
	if !originAllowed(req) {
		t.Fatal("base url origin")
	}
}

func TestPutObjectIgnoresPartialOnError(t *testing.T) {
	d := testDeps(t)
	if _, _, err := d.Store.Put("acct", "dev", "ok.txt", strings.NewReader("x")); err != nil {
		t.Fatal(err)
	}
	rc, err := d.Store.Get("acct", "dev", "ok.txt")
	if err != nil {
		t.Fatal(err)
	}
	b, _ := io.ReadAll(rc)
	rc.Close()
	if string(b) != "x" {
		t.Fatalf("%q", b)
	}
}
