package handlers

import (
	"bytes"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
	"gt.plainskill.net/LibreLoom/LunaConnect/internal/store"
)

const privTestLuna = "luna-private"

// privFixture makes an account with one Luna whose signing key is lunaPriv, and an auth key pair.
func privFixture(t *testing.T) (d Deps, acct string, lunaPriv hybridKey, authPub []byte, authPriv hybridKey) {
	t.Helper()
	d = testDeps(t)
	acct = cloudAccount(t, d, "private@example.com")
	cloudLuna(t, d, acct, privTestLuna, "Home")
	lpriv := newHybridKey(t)
	authPriv = newHybridKey(t)
	authPub = authPriv.pub
	if _, err := d.DB.Exec(`UPDATE luna_ids SET signing_public = ? WHERE account_id = ? AND luna_id = ?`,
		lpriv.pubHex(), acct, privTestLuna); err != nil {
		t.Fatal(err)
	}
	return d, acct, lpriv, authPub, authPriv
}

// privWriteScope stores pscopes/<scope> for userID, signed by signWith.
func privWriteScope(t *testing.T, d Deps, acct, scope, userID string, authPub []byte, signWith hybridKey) {
	t.Helper()
	sealPublic := bytes.Repeat([]byte{7}, sealPublicLen)
	scopePublic := bytes.Repeat([]byte{8}, sealPublicLen)
	sealedScopeSecret := []byte("sealed scope secret")
	sealed := []byte("sealed")
	created := time.Now().Unix()
	var c [8]byte
	binary.BigEndian.PutUint64(c[:], uint64(created))
	msg := lunaCanonical(
		[2][]byte{[]byte("luna_id"), []byte(privTestLuna)},
		[2][]byte{[]byte("scope"), []byte(scope)},
		[2][]byte{[]byte("user_id"), []byte(userID)},
		[2][]byte{[]byte("seal_public"), sealPublic},
		[2][]byte{[]byte("auth_public"), authPub},
		[2][]byte{[]byte("created_at"), c[:]},
		[2][]byte{[]byte("scope_public"), scopePublic},
		[2][]byte{[]byte("sealed_scope_secret"), sealedScopeSecret},
		[2][]byte{[]byte("sealed_dedup"), sealed},
	)
	sig := signWith.sign(t, privateScopeDomain, msg)
	data, err := json.Marshal(map[string]any{
		"record": map[string]any{
			"luna_id": privTestLuna, "scope": scope, "user_id": userID,
			"seal_public": hex.EncodeToString(sealPublic), "auth_public": hex.EncodeToString(authPub),
			"created_at": created, "scope_public": hex.EncodeToString(scopePublic),
			"sealed_scope_secret": hex.EncodeToString(sealedScopeSecret), "sealed_dedup": hex.EncodeToString(sealed),
		},
		"signature": hex.EncodeToString(sig),
	})
	if err != nil {
		t.Fatal(err)
	}
	cloudRecord(t, d, acct, privTestLuna, "pscopes", scope, data)
}

// privSign signs a challenge for scope the way the client's auth key does.
func privSign(t *testing.T, priv hybridKey, scope, challengeHex string) string {
	challenge, _ := hex.DecodeString(challengeHex)
	msg := lunaCanonical(
		[2][]byte{[]byte("luna_id"), []byte(privTestLuna)},
		[2][]byte{[]byte("scope"), []byte(scope)},
		[2][]byte{[]byte("challenge"), challenge},
	)
	return hex.EncodeToString(priv.sign(t, privateOpenDomain, msg))
}

// privShareLink inserts a share link and returns its id (the linkID that resolveShare reports).
func privShareLink(t *testing.T, d Deps, acct, kind, value string) string {
	t.Helper()
	id, err := randomHex(8)
	if err != nil {
		t.Fatal(err)
	}
	tok, err := randomHex(16)
	if err != nil {
		t.Fatal(err)
	}
	now := time.Now().Unix()
	if _, err := d.DB.Exec(`INSERT INTO share_links (id, account_id, luna_id, token_hash, scope_kind, scope_value, created_at, expires_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, id, acct, privTestLuna, id+tok, kind, value, now, now+86400); err != nil {
		t.Fatal(err)
	}
	return id
}

func TestPrivateOpenWithGoodSignature(t *testing.T) {
	d, acct, lunaPriv, authPub, authPriv := privFixture(t)
	privWriteScope(t, d, acct, "main", "user_a", authPub, lunaPriv)
	s := readScope{AccountID: acct, LunaID: privTestLuna}
	now := time.Now()
	ch, err := newPrivateChallenge(d, s, "", now)
	if err != nil {
		t.Fatal(err)
	}
	token, expiresAt, err := openPrivateSession(d, s, "", "main", ch, privSign(t, authPriv, "main", ch), now)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if len(token) != 64 || expiresAt != now.Add(privateSessionTTL*time.Second).Unix() {
		t.Fatalf("bad token or expiry: %q %d", token, expiresAt)
	}
	got, err := privateSessionScope(d, s, "", token, now)
	if err != nil || got != "main" {
		t.Fatalf("session scope = %q, %v; want main", got, err)
	}
}

func TestPrivateChallengeIsSingleUse(t *testing.T) {
	d, acct, lunaPriv, authPub, authPriv := privFixture(t)
	privWriteScope(t, d, acct, "main", "user_a", authPub, lunaPriv)
	s := readScope{AccountID: acct, LunaID: privTestLuna}
	now := time.Now()
	ch, _ := newPrivateChallenge(d, s, "", now)
	sig := privSign(t, authPriv, "main", ch)
	if _, _, err := openPrivateSession(d, s, "", "main", ch, sig, now); err != nil {
		t.Fatalf("first open: %v", err)
	}
	if _, _, err := openPrivateSession(d, s, "", "main", ch, sig, now); !errors.Is(err, errPrivateDenied) {
		t.Fatalf("second open err = %v; want denied", err)
	}
}

func TestPrivateChallengeExpires(t *testing.T) {
	d, acct, lunaPriv, authPub, authPriv := privFixture(t)
	privWriteScope(t, d, acct, "main", "user_a", authPub, lunaPriv)
	s := readScope{AccountID: acct, LunaID: privTestLuna}
	now := time.Now()
	ch, _ := newPrivateChallenge(d, s, "", now)
	late := now.Add((privateChallengeTTL + 1) * time.Second)
	if _, _, err := openPrivateSession(d, s, "", "main", ch, privSign(t, authPriv, "main", ch), late); !errors.Is(err, errPrivateDenied) {
		t.Fatalf("expired challenge err = %v; want denied", err)
	}
}

func TestPrivateOpenRejectsForgedScopeRecord(t *testing.T) {
	d, acct, _, authPub, authPriv := privFixture(t)
	otherPriv := newHybridKey(t)
	privWriteScope(t, d, acct, "main", "user_a", authPub, otherPriv)
	s := readScope{AccountID: acct, LunaID: privTestLuna}
	now := time.Now()
	ch, _ := newPrivateChallenge(d, s, "", now)
	if _, _, err := openPrivateSession(d, s, "", "main", ch, privSign(t, authPriv, "main", ch), now); !errors.Is(err, errPrivateDenied) {
		t.Fatalf("forged record err = %v; want denied", err)
	}
}

func TestPrivateOpenWrongAuthKey(t *testing.T) {
	d, acct, lunaPriv, authPub, _ := privFixture(t)
	privWriteScope(t, d, acct, "main", "user_a", authPub, lunaPriv)
	wrongPriv := newHybridKey(t)
	s := readScope{AccountID: acct, LunaID: privTestLuna}
	now := time.Now()
	ch, _ := newPrivateChallenge(d, s, "", now)
	if _, _, err := openPrivateSession(d, s, "", "main", ch, privSign(t, wrongPriv, "main", ch), now); !errors.Is(err, errPrivateDenied) {
		t.Fatalf("wrong key err = %v; want denied", err)
	}
}

func TestPrivateSessionExpires(t *testing.T) {
	d, acct, lunaPriv, authPub, authPriv := privFixture(t)
	privWriteScope(t, d, acct, "main", "user_a", authPub, lunaPriv)
	s := readScope{AccountID: acct, LunaID: privTestLuna}
	now := time.Now()
	ch, _ := newPrivateChallenge(d, s, "", now)
	token, _, err := openPrivateSession(d, s, "", "main", ch, privSign(t, authPriv, "main", ch), now)
	if err != nil {
		t.Fatal(err)
	}
	late := now.Add((privateSessionTTL + 1) * time.Second)
	if got, err := privateSessionScope(d, s, "", token, late); err != nil || got != "" {
		t.Fatalf("expired session scope = %q, %v; want empty", got, err)
	}
}

func TestShareUserLinkOnlyOpensItsUser(t *testing.T) {
	d, acct, lunaPriv, authPub, authPriv := privFixture(t)
	privWriteScope(t, d, acct, "other", "user_b", authPub, lunaPriv)
	privWriteScope(t, d, acct, "main", "user_a", authPub, lunaPriv)
	linkID := privShareLink(t, d, acct, "user", scopePart("user_a"))
	s := readScope{AccountID: acct, LunaID: privTestLuna, Kind: "user", Value: scopePart("user_a")}
	now := time.Now()

	ch, _ := newPrivateChallenge(d, s, linkID, now)
	if _, _, err := openPrivateSession(d, s, linkID, "other", ch, privSign(t, authPriv, "other", ch), now); !errors.Is(err, errPrivateDenied) {
		t.Fatalf("other user's scope err = %v; want denied", err)
	}

	ch, _ = newPrivateChallenge(d, s, linkID, now)
	token, _, err := openPrivateSession(d, s, linkID, "main", ch, privSign(t, authPriv, "main", ch), now)
	if err != nil {
		t.Fatalf("own scope: %v", err)
	}
	if got, _ := privateSessionScope(d, s, linkID, token, now); got != "main" {
		t.Fatalf("session scope = %q; want main", got)
	}
}

func TestShareBackupLinkNeverOpens(t *testing.T) {
	d, acct, lunaPriv, authPub, authPriv := privFixture(t)
	privWriteScope(t, d, acct, "main", "user_a", authPub, lunaPriv)
	linkID := privShareLink(t, d, acct, "backup", "backup-1")
	s := readScope{AccountID: acct, LunaID: privTestLuna, Kind: "backup", Value: "backup-1"}
	now := time.Now()
	ch, _ := newPrivateChallenge(d, s, linkID, now)
	if _, _, err := openPrivateSession(d, s, linkID, "main", ch, privSign(t, authPriv, "main", ch), now); !errors.Is(err, errPrivateDenied) {
		t.Fatalf("backup link err = %v; want denied", err)
	}
}

func TestLunaCanonicalMatchesRust(t *testing.T) {
	// Same vector as crates/lunad/src/backup/cloud/crypto.rs canonical_is_length_prefixed_and_unambiguous.
	got := lunaCanonical([2][]byte{[]byte("ab"), []byte("c")})
	want := []byte{0, 0, 0, 2, 'a', 'b', 0, 0, 0, 1, 'c'}
	if !bytes.Equal(got, want) {
		t.Fatalf("canonical = %v; want %v", got, want)
	}
	if bytes.Equal(lunaCanonical([2][]byte{[]byte("ab"), []byte("c")}), lunaCanonical([2][]byte{[]byte("a"), []byte("bc")})) {
		t.Fatal("canonical is ambiguous")
	}
}

// TestPrivateOpenAcceptsRustFixture opens a session with the signed private items that lunad writes in its
// cloud fixture, so the Go side is checked against the Rust side's exact bytes and signatures.
func TestPrivateOpenAcceptsRustFixture(t *testing.T) {
	type fixtureRecord struct {
		Name string `json:"name"`
		Data string `json:"data"`
	}
	var fx struct {
		LunaID        string `json:"luna_id"`
		SigningPublic string `json:"signing_public"`
		Private       struct {
			Scope         string `json:"scope"`
			Challenge     string `json:"challenge"`
			OpenSignature string `json:"open_signature"`
			Records       struct {
				PScopes    []fixtureRecord `json:"pscopes"`
				PSnapshots []fixtureRecord `json:"psnapshots"`
			} `json:"records"`
		} `json:"private"`
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "crates", "lunad", "src", "backup", "cloud", "fixture.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &fx); err != nil {
		t.Fatal(err)
	}

	d := testDeps(t)
	acct := cloudAccount(t, d, "fixture@example.com")
	cloudLuna(t, d, acct, fx.LunaID, "Fixture")
	if _, err := d.DB.Exec(`UPDATE luna_ids SET signing_public = ? WHERE account_id = ? AND luna_id = ?`,
		fx.SigningPublic, acct, fx.LunaID); err != nil {
		t.Fatal(err)
	}
	for kind, recs := range map[string][]fixtureRecord{"pscopes": fx.Private.Records.PScopes, "psnapshots": fx.Private.Records.PSnapshots} {
		for _, r := range recs {
			data, err := hex.DecodeString(r.Data)
			if err != nil {
				t.Fatal(err)
			}
			if _, _, err := d.Store.Put(acct, store.StorageSlot(fx.LunaID), store.StorageRecordPath(kind, r.Name), bytes.NewReader(data)); err != nil {
				t.Fatal(err)
			}
		}
	}

	s := readScope{AccountID: acct, LunaID: fx.LunaID}
	now := time.Now()
	if _, err := d.DB.Exec(`INSERT INTO private_challenges (hash, account_id, luna_id, link_id, expires_at)
VALUES (?, ?, ?, '', ?)`, security.HashToken(fx.Private.Challenge), acct, fx.LunaID, now.Add(privateChallengeTTL*time.Second).Unix()); err != nil {
		t.Fatal(err)
	}
	token, _, err := openPrivateSession(d, s, "", fx.Private.Scope, fx.Private.Challenge, fx.Private.OpenSignature, now)
	if err != nil {
		t.Fatalf("open with Rust fixture: %v", err)
	}
	if got, err := privateSessionScope(d, s, "", token, now); err != nil || got != fx.Private.Scope {
		t.Fatalf("session scope = %q, %v; want %q", got, err, fx.Private.Scope)
	}
}
