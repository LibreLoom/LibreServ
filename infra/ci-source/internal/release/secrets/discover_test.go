package secrets

import (
	"encoding/base64"
	"strings"
	"testing"
)

func TestIsMinisignSecretTextRejectsSignatures(t *testing.T) {
	raw := append([]byte("Ed"), make([]byte, 156)...)
	blob := base64.StdEncoding.EncodeToString(raw)
	key := "untrusted comment: minisign encrypted secret key\n" + blob + "\n"
	if !isMinisignSecretText([]byte(key)) {
		t.Fatal("real key rejected")
	}
	sig := "untrusted comment: signature from minisign secret key\nRUQ" + strings.Repeat("A", 90) + "==\ntrusted comment: x\n" + strings.Repeat("B", 88) + "\n"
	if isMinisignSecretText([]byte(sig)) {
		t.Fatal(".minisig accepted as a secret key")
	}
	if isMinisignSecretText([]byte("untrusted comment: minisign secret key\nnot base64\n")) {
		t.Fatal("garbage second line accepted")
	}
}
