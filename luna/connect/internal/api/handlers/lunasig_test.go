package handlers

import (
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/mldsa"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"testing"
)

// hybridKey is a Luna-style signing key: an Ed25519 key and an ML-DSA-65 key made from one seed.
type hybridKey struct {
	pub []byte
	ed  ed25519.PrivateKey
	ml  *mldsa.PrivateKey
}

// hybridFromSeed mirrors Signer::from_seed in crypto.rs.
func hybridFromSeed(t testing.TB, seed []byte) hybridKey {
	t.Helper()
	ed := ed25519.NewKeyFromSeed(seed)
	mlSeed, err := hkdf.Key(sha256.New, seed, nil, "luna-mldsa-v1", 32)
	if err != nil {
		t.Fatal(err)
	}
	ml, err := mldsa.NewPrivateKey(mldsa.MLDSA65(), mlSeed)
	if err != nil {
		t.Fatal(err)
	}
	pub := append(append([]byte{}, ed.Public().(ed25519.PublicKey)...), ml.PublicKey().Bytes()...)
	return hybridKey{pub: pub, ed: ed, ml: ml}
}

func newHybridKey(t testing.TB) hybridKey {
	t.Helper()
	seed := make([]byte, 32)
	if _, err := rand.Read(seed); err != nil {
		t.Fatal(err)
	}
	return hybridFromSeed(t, seed)
}

// sign mirrors Signer::sign: both halves over "luna-sig-v2\x00" + domain + "\x00" + msg.
func (k hybridKey) sign(t testing.TB, domain string, msg []byte) []byte {
	t.Helper()
	signed := append([]byte("luna-sig-v2\x00"+domain+"\x00"), msg...)
	ml, err := k.ml.SignDeterministic(signed, &mldsa.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return append(ed25519.Sign(k.ed, signed), ml...)
}

func (k hybridKey) pubHex() string { return hex.EncodeToString(k.pub) }

func TestLunaVerifyNeedsBothHalves(t *testing.T) {
	k := newHybridKey(t)
	msg := []byte("record")
	sig := k.sign(t, "snapshot", msg)
	if len(k.pub) != lunaSigPublicLen || len(sig) != lunaSigLen {
		t.Fatalf("sizes %d/%d", len(k.pub), len(sig))
	}
	if !lunaVerify(k.pub, "snapshot", msg, sig) {
		t.Fatal("a good signature was refused")
	}
	if lunaVerify(k.pub, "other", msg, sig) || lunaVerify(k.pub, "snapshot", []byte("changed"), sig) {
		t.Fatal("a signature passed for the wrong domain or message")
	}
	edBad := append([]byte{}, sig...)
	edBad[0] ^= 1
	mlBad := append([]byte{}, sig...)
	mlBad[len(mlBad)-1] ^= 1
	mlZero := append([]byte{}, sig...)
	for i := 64; i < len(mlZero); i++ {
		mlZero[i] = 0
	}
	for name, bad := range map[string][]byte{"ed25519 half": edBad, "ml-dsa half": mlBad, "ml-dsa zeroed": mlZero} {
		if lunaVerify(k.pub, "snapshot", msg, bad) {
			t.Fatalf("a signature with a bad %s passed", name)
		}
	}
	other := newHybridKey(t)
	mixed := append(append([]byte{}, k.pub[:32]...), other.pub[32:]...)
	if lunaVerify(mixed, "snapshot", msg, sig) {
		t.Fatal("a key with someone else's ML-DSA half passed")
	}
}

// The Rust side signs vectors.json; Connect must accept those bytes.
func TestLunaVerifyAcceptsRustVector(t *testing.T) {
	data, err := os.ReadFile("../../../../crates/lunad/src/backup/cloud/vectors.json")
	if err != nil {
		t.Skipf("vectors.json is not mounted here: %v", err)
	}
	field := func(name string) []byte {
		key := `"` + name + `": "`
		i := strings.Index(string(data), key)
		if i < 0 {
			t.Fatalf("vectors.json has no %s", name)
		}
		rest := string(data)[i+len(key):]
		out, err := hex.DecodeString(rest[:strings.Index(rest, `"`)])
		if err != nil {
			t.Fatal(err)
		}
		return out
	}
	pub, sig := field("signer_public"), field("signature")
	if !lunaVerify(pub, "snapshot", []byte("snapshot record"), sig) {
		t.Fatal("Connect refused the signature Rust made for the vector")
	}
	sig[10] ^= 1
	if lunaVerify(pub, "snapshot", []byte("snapshot record"), sig) {
		t.Fatal("Connect accepted a corrupted vector signature")
	}
}
