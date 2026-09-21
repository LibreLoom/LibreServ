package system

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"aead.dev/minisign"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

func TestPinnedKeyMatchesRepoFile(t *testing.T) {
	repo := filepath.Join("..", "..", "..", "..", "keys", "libreserv.minisign.pub")
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

func TestFetchSignedChecksumAndApply(t *testing.T) {
	pub, priv, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	binaryName := fmt.Sprintf("libreserv-%s-%s", runtime.GOOS, runtime.GOARCH)
	payload := []byte("libreserv-update-bytes")
	sum := sha256.Sum256(payload)
	sumHex := hex.EncodeToString(sum[:])
	sums := fmt.Sprintf("%s  %s\n", sumHex, binaryName)
	sig := minisign.Sign(priv, []byte(sums))

	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/repos/owner/repo/releases", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `[{"tag_name":"v2.0.0","prerelease":false,"draft":false}]`)
	})
	mux.HandleFunc("/owner/repo/releases/download/v2.0.0/SHA256SUMS.txt", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(sums))
	})
	mux.HandleFunc("/owner/repo/releases/download/v2.0.0/SHA256SUMS.txt.minisig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(sig)
	})
	mux.HandleFunc("/owner/repo/releases/download/v2.0.0/"+binaryName, func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(payload)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	cfg := config.UpdatesConfig{Owner: "owner", Repo: "repo"}
	checker := NewUpdateChecker(cfg)
	checker.baseURL = server.URL + "/api/v1"
	checker.pinnedKeys = []minisign.PublicKey{pub}

	info, err := checker.CheckForUpdates("1.0.0", true)
	if err != nil {
		t.Fatal(err)
	}
	if !info.UpdateAvailable {
		t.Fatal("expected update available")
	}
	if info.Checksum != sumHex {
		t.Fatalf("checksum = %q, want %s", info.Checksum, sumHex)
	}

	// Apply would replace the test binary; only verify fetchSignedChecksum + hash path via a dry mismatch.
	got, err := checker.fetchSignedChecksum("v2.0.0")
	if err != nil {
		t.Fatal(err)
	}
	if got != sumHex {
		t.Fatalf("fetchSignedChecksum = %q, want %s", got, sumHex)
	}
}

func TestFetchSignedChecksumRejectsUnsigned(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/owner/repo/releases/download/v2.0.0/SHA256SUMS.txt", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("abc  libreserv-linux-amd64\n"))
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	cfg := config.UpdatesConfig{Owner: "owner", Repo: "repo"}
	checker := NewUpdateChecker(cfg)
	checker.baseURL = server.URL + "/api/v1"

	_, err := checker.fetchSignedChecksum("v2.0.0")
	if !errors.Is(err, ErrMissingSignature) {
		t.Fatalf("err = %v, want ErrMissingSignature", err)
	}
}

func TestFetchSignedChecksumRejectsWrongKey(t *testing.T) {
	_, priv, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	other, _, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sums := []byte("deadbeef  libreserv-linux-amd64\n")
	sig := minisign.Sign(priv, sums)

	mux := http.NewServeMux()
	mux.HandleFunc("/owner/repo/releases/download/v2.0.0/SHA256SUMS.txt", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(sums)
	})
	mux.HandleFunc("/owner/repo/releases/download/v2.0.0/SHA256SUMS.txt.minisig", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(sig)
	})
	server := httptest.NewServer(mux)
	defer server.Close()

	cfg := config.UpdatesConfig{Owner: "owner", Repo: "repo"}
	checker := NewUpdateChecker(cfg)
	checker.baseURL = server.URL + "/api/v1"
	checker.pinnedKeys = []minisign.PublicKey{other}

	_, err = checker.fetchSignedChecksum("v2.0.0")
	if !errors.Is(err, ErrBadSignature) {
		t.Fatalf("err = %v, want ErrBadSignature", err)
	}
}
