package support

import (
	"testing"
	"time"
)

func TestHandshakeSignatureAndVerify(t *testing.T) {
	secret := "supers3cret"
	code := "CODE1234"
	role := "device"
	nonce := "abc"
	ts := time.Now().Unix()

	sig := HandshakeSignature(secret, code, role, nonce, ts)
	if sig == "" {
		t.Fatalf("empty sig")
	}
	if !VerifyHandshake(secret, code, role, nonce, sig, ts, time.Minute) {
		t.Fatalf("expected verify ok")
	}
	if VerifyHandshake(secret, code, role, nonce, sig, ts-3600, time.Minute) {
		t.Fatalf("expected skew failure")
	}
}
