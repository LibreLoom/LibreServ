package secrets

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/asn1"
	"encoding/base64"
	"encoding/binary"
	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/scrypt"
	"math/big"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"aead.dev/minisign"
)

type testEnv struct {
	t    *testing.T
	home string
	repo string
	env  map[string]string
	red  *fakeRedactor
	run  Runner
	pr   *fakePrompter
}

type fakeRedactor struct {
	mu   sync.Mutex
	vals map[string]bool
}

func (f *fakeRedactor) Add(s string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.vals[s] = true
}
func (f *fakeRedactor) has(s string) bool { f.mu.Lock(); defer f.mu.Unlock(); return f.vals[s] }

type fakePrompter struct {
	answers map[string]Answer // by slot
	asked   []Question
}

func (p *fakePrompter) Ask(_ context.Context, q Question) (Answer, error) {
	p.asked = append(p.asked, q)
	return p.answers[q.Slot], nil
}

func newTestEnv(t *testing.T) *testEnv {
	t.Helper()
	d := t.TempDir()
	e := &testEnv{t: t, home: filepath.Join(d, "home"), repo: filepath.Join(d, "repo"),
		env: map[string]string{}, red: &fakeRedactor{vals: map[string]bool{}}}
	for _, p := range []string{e.home, filepath.Join(e.repo, "keys")} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	e.run = func(ctx context.Context, stdin string, env []string, name string, args ...string) ([]byte, error) {
		return nil, os.ErrNotExist
	}
	return e
}

func (e *testEnv) manager(mut ...func(*Options)) *Manager {
	o := Options{
		RepoRoot: e.repo, Home: e.home, Store: NewMemStore(), Redactor: e.red,
		Getenv: func(k string) string { return e.env[k] },
		Run: func(ctx context.Context, stdin string, env []string, name string, args ...string) ([]byte, error) {
			return e.run(ctx, stdin, env, name, args...)
		},
		ScanTimeout: 5 * time.Second,
	}
	if e.pr != nil {
		o.Prompter = e.pr
	}
	for _, f := range mut {
		f(&o)
	}
	return New(o)
}

// testKey is a generated minisign key.
type testKey struct {
	pub  minisign.PublicKey
	priv minisign.PrivateKey
}

func genKey(t *testing.T) testKey {
	t.Helper()
	pub, priv, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	return testKey{pub, priv}
}

func (e *testEnv) writePub(file string, k testKey) {
	b, _ := k.pub.MarshalText()
	text := string(b)
	if !strings.HasSuffix(text, "\n") {
		text += "\n"
	}
	e.write(filepath.Join(e.repo, "keys", file), text)
}

// encrypted is a minisign encrypted secret key with deliberately cheap scrypt
// settings (the real tool's cost is about a second per try, far too slow for
// tests under -race). The key file records its own settings, so DecryptKey
// opens it like any other.
func (e *testEnv) encrypted(k testKey, pw string) string {
	e.t.Helper()
	text, err := k.priv.MarshalText()
	if err != nil {
		e.t.Fatal(err)
	}
	line := strings.Split(strings.TrimSpace(string(text)), "\n")
	raw, err := base64.StdEncoding.DecodeString(line[len(line)-1])
	if err != nil || len(raw) != 158 {
		e.t.Fatalf("unexpected key layout: %v %d", err, len(raw))
	}
	plain := raw[54:126] // key ID + ed25519 private key
	const ops, mem = uint64(1 << 15), uint64(1 << 20)
	var salt [32]byte
	if _, err := rand.Read(salt[:]); err != nil {
		e.t.Fatal(err)
	}
	// minisign's conversion of (ops, mem) to scrypt settings, for mem >= 32*ops.
	r := 8
	N := 1
	for n := 1; n < 63; n++ {
		if N = 1 << n; uint64(N) > mem/(256*uint64(r)) {
			break
		}
	}
	p := int((ops/4)/uint64(N)) / r
	ks, err := scrypt.Key([]byte(pw), salt[:], N, r, p, 104)
	if err != nil {
		e.t.Fatal(err)
	}
	var msg [74]byte
	binary.LittleEndian.PutUint16(msg[:2], 0x6445) // "Ed"
	copy(msg[2:], plain)
	sum := blake2b.Sum256(msg[:])
	ct := make([]byte, 104)
	copy(ct, plain)
	copy(ct[72:], sum[:])
	for i := range ct {
		ct[i] ^= ks[i]
	}
	var out [158]byte
	binary.LittleEndian.PutUint16(out[0:], 0x6445)
	binary.LittleEndian.PutUint16(out[2:], 0x6353) // "Sc"
	binary.LittleEndian.PutUint16(out[4:], 0x3242) // "B2"
	copy(out[6:38], salt[:])
	binary.LittleEndian.PutUint64(out[38:], ops)
	binary.LittleEndian.PutUint64(out[46:], mem)
	copy(out[54:], ct)
	return "untrusted comment: minisign encrypted secret key\n" + base64.StdEncoding.EncodeToString(out[:]) + "\n"
}

func (e *testEnv) write(path, content string) {
	e.t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		e.t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
		e.t.Fatal(err)
	}
}

func selfSigned(t *testing.T) (*ecdsa.PrivateKey, *x509.Certificate) {
	t.Helper()
	k, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: "luna test"},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour)}
	der, err := x509.CreateCertificate(rand.Reader, tpl, tpl, &k.PublicKey, k)
	if err != nil {
		t.Fatal(err)
	}
	c, _ := x509.ParseCertificate(der)
	return k, c
}

// buildJKS writes a JKS version 2 store with one private-key entry.
func buildJKS(t *testing.T, alias, storePW, keyPW string, cert *x509.Certificate, key *ecdsa.PrivateKey) []byte {
	t.Helper()
	pkcs8, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	salt := make([]byte, 20)
	_, _ = rand.Read(salt)
	pw := jksPassBytes(keyPW)
	enc := make([]byte, len(pkcs8))
	digest := salt
	for i := 0; i < len(enc); {
		h := sha1.New()
		h.Write(pw)
		h.Write(digest)
		digest = h.Sum(nil)
		for j := 0; j < len(digest) && i < len(enc); j, i = j+1, i+1 {
			enc[i] = pkcs8[i] ^ digest[j]
		}
	}
	h := sha1.New()
	h.Write(pw)
	h.Write(pkcs8)
	protectedData := append(append(append([]byte{}, salt...), enc...), h.Sum(nil)...)
	der, err := asn1.Marshal(struct {
		Algo pkix.AlgorithmIdentifier
		Data []byte
	}{pkix.AlgorithmIdentifier{Algorithm: asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 42, 2, 17, 1, 1}, Parameters: asn1.NullRawValue}, protectedData})
	if err != nil {
		t.Fatal(err)
	}
	var b []byte
	u32 := func(v uint32) { b = binary.BigEndian.AppendUint32(b, v) }
	utf := func(s string) { b = binary.BigEndian.AppendUint16(b, uint16(len(s))); b = append(b, s...) }
	u32(0xFEEDFEED)
	u32(2)
	u32(1)
	u32(1)
	utf(strings.ToLower(alias))
	b = binary.BigEndian.AppendUint64(b, uint64(time.Now().UnixMilli()))
	u32(uint32(len(der)))
	b = append(b, der...)
	u32(1)
	utf("X.509")
	u32(uint32(len(cert.Raw)))
	b = append(b, cert.Raw...)
	hh := sha1.New()
	hh.Write(jksPassBytes(storePW))
	hh.Write([]byte("Mighty Aphrodite"))
	hh.Write(b)
	return append(b, hh.Sum(nil)...)
}
