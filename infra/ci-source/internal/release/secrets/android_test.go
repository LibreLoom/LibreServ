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
	e.env["LUNA_ANDROID_STORE_PASSWORD"] = "storepw"
	e.env["LUNA_ANDROID_KEY_PASSWORD"] = "keypw"

	m := e.manager(func(o *Options) { o.NoHomeScan = true })
	ctx := context.Background()
	ks, st := m.Android(ctx)
	if st.State != Proven || ks == nil || ks.Alias != "luna" || ks.KeyPassword != "keypw" {
		t.Fatalf("%+v", st)
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
	// Wrong key password.
	m.PinAndroidCert("")
	e.env["LUNA_ANDROID_KEY_PASSWORD"] = "bad"
	m2 := e.manager(func(o *Options) { o.NoHomeScan = true })
	if st := m2.Status(ctx, AndroidKeystore); st.State != Failed {
		t.Fatalf("wrong key password must fail: %+v", st)
	}
}

func TestAndroidWrongKeyPassword(t *testing.T) {
	e := newTestEnv(t)
	key, cert := selfSigned(t)
	e.write(filepath.Join(e.home, ".android", "r.jks"), string(buildJKS(t, "luna", "storepw", "keypw", cert, key)))
	e.env["LUNA_ANDROID_STORE_PASSWORD"] = "storepw"
	e.env["LUNA_ANDROID_KEY_PASSWORD"] = "bad"
	m := e.manager(func(o *Options) { o.NoHomeScan = true })
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
	if st := m.Status(ctx, AndroidKeystore); st.State != Failed {
		t.Fatalf("no password yet: %+v", st)
	}
	e.pr = &fakePrompter{answers: map[string]Answer{SlotAndroidStorePW: {Value: "pw12"}}}
	m = e.manager(func(o *Options) { o.NoHomeScan = true })
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
