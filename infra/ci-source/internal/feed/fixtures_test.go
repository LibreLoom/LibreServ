package feed_test

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"aead.dev/minisign"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/feed"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/feedfixtures"
)

const dataDir = "../../../feed-testdata"

type caseFile struct {
	Key   string `json:"key"`
	Cases []struct {
		Name   string `json:"name"`
		Feed   string `json:"feed"`
		Sig    string `json:"sig"`
		Expect string `json:"expect"`
	} `json:"cases"`
}

func readAll(t *testing.T, dir string) map[string][]byte {
	t.Helper()
	m := map[string][]byte{}
	err := filepath.Walk(dir, func(p string, i os.FileInfo, err error) error {
		if err != nil || i.IsDir() {
			return err
		}
		b, err := os.ReadFile(p)
		rel, _ := filepath.Rel(dir, p)
		m[rel] = b
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// Signature-level expectations: only bad-signature cases fail verification.
func TestFixtureSignatures(t *testing.T) {
	var cf caseFile
	b, err := os.ReadFile(filepath.Join(dataDir, "cases.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(b, &cf); err != nil {
		t.Fatal(err)
	}
	pub, err := minisign.PublicKeyFromFile(filepath.Join(dataDir, cf.Key))
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cf.Cases {
		fb, err := os.ReadFile(filepath.Join(dataDir, c.Feed))
		if err != nil {
			t.Fatal(err)
		}
		sb, err := os.ReadFile(filepath.Join(dataDir, c.Sig))
		if err != nil {
			t.Fatal(err)
		}
		want := c.Expect != "reject:bad-signature"
		if got := feed.Verify(pub, fb, sb); got != want {
			t.Errorf("%s: verify=%v, want %v", c.Name, got, want)
		}
		if want {
			var f feed.Feed
			if err := json.Unmarshal(fb, &f); err != nil {
				t.Errorf("%s: %v", c.Name, err)
			}
		}
	}
}

// Regenerating must reproduce the committed fixtures byte for byte.
func TestGenerateIsDeterministic(t *testing.T) {
	dir := t.TempDir()
	if err := feedfixtures.Generate(dir); err != nil {
		t.Fatal(err)
	}
	got, want := readAll(t, dir), readAll(t, dataDir)
	for name, w := range want {
		if strings.HasSuffix(name, "README.md") {
			continue
		}
		if !bytes.Equal(got[name], w) {
			t.Errorf("%s differs from committed fixture (run feedgen)", name)
		}
	}
	for name := range got {
		if _, ok := want[name]; !ok {
			t.Errorf("%s generated but not committed", name)
		}
	}
}
