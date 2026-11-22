package secrets

import (
	"context"
	"encoding/base64"
	"path/filepath"
	"strings"
	"testing"

	"software.sslmate.com/src/go-pkcs12"
)

func TestAndroidJKS(t *testing.T) {
	e := newTestEnv(t)
	key, cert := selfSigned(t)
	jks := buildJKS(t, "luna", "storepw", "keypw", cert, key)
	e.write(filepath.Join(e.home, ".android", "release.jks"), string(jks))
	// A decoy keystore with another alias: rejected with a reason.
	k2, c2 := selfSigned(t)
	e.write(filepath.Join(e.home, ".android", "other.keystore"), string(buildJKS(t, "debug", "storepw", "storepw", c2, k2)))
	// The release passphrase is the store password; the key has its own,
	// asked by name.
	e.pr = passphrases("storepw", "keypw")

	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	ctx := context.Background()
	if st := m.Status(ctx, AndroidKeystore); st.State != Locked || len(e.pr.asked) != 0 {
		t.Fatalf("before unlock: %+v (asked %d)", st, len(e.pr.asked))
	}
	if err := m.Unlock(ctx, AndroidKeystore); err != nil {
		t.Fatal(err)
	}
	ks, st := m.Android(ctx)
	if st.State != Proven || ks == nil || ks.Alias != "luna" || string(ks.KeyPassword) != "keypw" || string(ks.StorePassword) != "storepw" {
		t.Fatalf("%+v", st)
	}
	if qs := e.pr.passQuestions(); len(qs) != 2 || !strings.Contains(qs[1].Label, "keystore") || !strings.Contains(qs[1].Label, "release.jks") {
		t.Fatalf("questions: %+v", qs)
	}
	if ks.CertSHA256 != fullHash(cert.Raw) {
		t.Fatal("fingerprint mismatch")
	}
	if !strings.Contains(st.Summary, "Not pinned") {
		t.Fatalf("summary: %s", st.Summary)
	}
	var rejected bool
	for _, c := range st.Candidates {
		if c.Outcome == Rejected && strings.Contains(c.Reason, "aliases") {
			rejected = true
		}
	}
	if !rejected {
		t.Fatalf("decoy not reported: %+v", st.Candidates)
	}
	// Pin to the right and to a wrong fingerprint.
	if err := m.PinAndroidCert(colonHex(fullHash(cert.Raw))); err != nil {
		t.Fatal(err)
	}
	if st := m.Status(ctx, AndroidKeystore); st.State != Proven || strings.Contains(st.Summary, "Not pinned") {
		t.Fatalf("%+v", st)
	}
	if err := m.PinAndroidCert(strings.Repeat("ab", 32)); err != nil {
		t.Fatal(err)
	}
	if st := m.Status(ctx, AndroidKeystore); st.State != Failed {
		t.Fatalf("wrong pin should fail: %+v", st)
	}
	m.PinAndroidCert("")

	// Wipe zeroes the keystore passwords.
	if err := m.Unlock(ctx, AndroidKeystore); err != nil {
		t.Fatal(err)
	}
	ks, _ = m.Android(ctx)
	storeB, keyB := ks.StorePassword, ks.KeyPassword
	m.Wipe()
	if strings.Trim(string(storeB)+string(keyB), "\x00") != "" || ks.StorePassword != nil {
		t.Fatalf("keystore passwords not wiped: %q %q", storeB, keyB)
	}
	if st := m.Status(ctx, AndroidKeystore); st.State != Locked {
		t.Fatalf("after wipe: %+v", st)
	}
}

func TestAndroidOnePassphraseForStoreAndKey(t *testing.T) {
	e := newTestEnv(t)
	key, cert := selfSigned(t)
	e.write(filepath.Join(e.home, ".android", "r.jks"), string(buildJKS(t, "luna", "release", "release", cert, key)))
	e.pr = passphrases("release")
	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	if err := m.Unlock(context.Background(), AndroidKeystore); err != nil {
		t.Fatal(err)
	}
	if n := len(e.pr.passQuestions()); n != 1 {
		t.Fatalf("asked %d times", n)
	}
}

func TestAndroidPasswordsNeverFromEnv(t *testing.T) {
	e := newTestEnv(t)
	key, cert := selfSigned(t)
	e.write(filepath.Join(e.home, ".android", "r.jks"), string(buildJKS(t, "luna", "storepw", "storepw", cert, key)))
	e.env["LUNA_ANDROID_STORE_PASSWORD"] = "storepw"
	e.env["LUNA_ANDROID_KEY_PASSWORD"] = "storepw"
	store := NewMemStore()
	store.Set("android-store-password", "storepw")
	m := e.manager(func(o *Options) { o.NoHomeScan = true; o.Store = store })
	if st := m.Status(context.Background(), AndroidKeystore); st.State != Locked {
		t.Fatalf("a password came from env or the store: %+v", st)
	}
}

func TestAndroidWrongKeyPassword(t *testing.T) {
	e := newTestEnv(t)
	key, cert := selfSigned(t)
	e.write(filepath.Join(e.home, ".android", "r.jks"), string(buildJKS(t, "luna", "storepw", "keypw", cert, key)))
	// The store opens with the release passphrase; the key's own is never
	// typed (the user skips).
	e.pr = passphrases("storepw")
	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	if err := m.Unlock(context.Background(), AndroidKeystore); err == nil {
		t.Fatal("unlocked without the key password")
	}
	st := m.Status(context.Background(), AndroidKeystore)
	if st.State != Failed || !strings.Contains(st.Candidates[0].Reason, "key password") {
		t.Fatalf("%+v", st)
	}
}

func TestAndroidP12FromEnvB64AndPrompt(t *testing.T) {
	e := newTestEnv(t)
	key, cert := selfSigned(t)
	p12, err := pkcs12.Modern.Encode(key, cert, nil, "pw12")
	if err != nil {
		t.Fatal(err)
	}
	e.env["LUNA_ANDROID_KEYSTORE_B64"] = base64.StdEncoding.EncodeToString(p12)
	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	ctx := context.Background()
	if st := m.Status(ctx, AndroidKeystore); st.State != Locked {
		t.Fatalf("no passphrase yet: %+v", st)
	}
	e.pr = passphrases("pw12")
	m = e.manager(func(o *Options) { o.NoHomeScan = true })
	if err := m.Unlock(ctx, AndroidKeystore); err != nil {
		t.Fatal(err)
	}
	ks, st := m.Android(ctx)
	if st.State != Proven || ks == nil || ks.Path != "" {
		t.Fatalf("%+v", st)
	}
	p, err := ks.Materialize(t.TempDir())
	if err != nil || p == "" {
		t.Fatal(err)
	}
}

func TestAndroidMissing(t *testing.T) {
	e := newTestEnv(t)
	m := e.manager()
	if st := m.Status(context.Background(), AndroidKeystore); st.State != Missing {
		t.Fatalf("%+v", st)
	}
}
