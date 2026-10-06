package system

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPinnedKeyMatchesRepoFile(t *testing.T) {
	repo := filepath.Join("..", "..", "..", "..", "..", "keys", "libreserv.minisign.pub")
	want, err := os.ReadFile(repo)
	if err != nil {
		t.Fatalf("read repo public key: %v", err)
	}
	if strings.TrimSpace(string(want)) != strings.TrimSpace(pinnedPubFile) {
		t.Fatal("embedded releases.minisign.pub does not match keys/libreserv.minisign.pub")
	}
	if len(parseMinisignPub(pinnedPubFile)) == 0 {
		t.Fatal("pinned public key did not parse")
	}
}
