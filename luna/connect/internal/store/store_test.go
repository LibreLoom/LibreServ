package store

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPathRejectsTraversalAndOpaqueIDs(t *testing.T) {
	s, err := NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	bads := [][3]string{
		{"acct/../x", "dev_1", "file.txt"},
		{"acct_1", "../dev", "file.txt"},
		{"acct_1", "dev_1", "../escape.txt"},
		{"acct_1", "dev_1", "..\\escape.txt"},
		{"acct_1", "dev_1", "a/../../etc/passwd"},
		{"acct_1", "dev_1", "ok\x00.txt"},
		{"ac\x00ct", "dev_1", "file.txt"},
		{"acct_1", "dev\\..\\x", "file.txt"},
	}
	for _, b := range bads {
		if _, err := s.path(b[0], b[1], b[2]); err == nil {
			t.Fatalf("accepted %q %q %q", b[0], b[1], b[2])
		}
	}
}

func TestPutGetStaysUnderRoot(t *testing.T) {
	root := t.TempDir()
	s, err := NewLocal(root)
	if err != nil {
		t.Fatal(err)
	}
	if st, err := os.Stat(s.Root); err != nil || st.Mode().Perm() != 0o700 {
		t.Fatalf("root perms: %v %v", st, err)
	}
	n, be, err := s.Put("acct_1", "dev_1", "Photos/a.jpg", strings.NewReader("hello"))
	if err != nil || n != 5 || be != BackendLocal {
		t.Fatalf("put %d be=%q %v", n, be, err)
	}
	p := filepath.Join(s.Root, "acct_1", "dev_1", "Photos", "a.jpg")
	st, err := os.Stat(p)
	if err != nil {
		t.Fatal(err)
	}
	if st.Mode().Perm() != 0o600 {
		t.Fatalf("file perms %o", st.Mode().Perm())
	}
	rc, err := s.Get("acct_1", "dev_1", "Photos/a.jpg")
	if err != nil {
		t.Fatal(err)
	}
	defer rc.Close()
	got, _ := io.ReadAll(rc)
	if !bytes.Equal(got, []byte("hello")) {
		t.Fatalf("got %q", got)
	}
	outside, err := filepath.Abs(filepath.Join(root, "..", "escaped"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.HasPrefix(p, outside) {
		t.Fatal("object escaped root")
	}
}

// failingReader yields some bytes and then fails, like a dropped upload.
type failingReader struct {
	data []byte
	err  error
}

func (f *failingReader) Read(p []byte) (int, error) {
	if len(f.data) > 0 {
		n := copy(p, f.data)
		f.data = f.data[n:]
		return n, nil
	}
	return 0, f.err
}

func TestLocalPutFailureKeepsExistingObject(t *testing.T) {
	s, err := NewLocal(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := s.Put("acct_1", "dev_1", "a.txt", strings.NewReader("old")); err != nil {
		t.Fatal(err)
	}
	_, _, err = s.Put("acct_1", "dev_1", "a.txt", &failingReader{data: []byte("partial"), err: io.ErrUnexpectedEOF})
	if err == nil {
		t.Fatal("failed upload reported success")
	}
	rc, err := s.Get("acct_1", "dev_1", "a.txt")
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(rc)
	rc.Close()
	if string(got) != "old" {
		t.Fatalf("existing object changed to %q", got)
	}
	p, err := s.path("acct_1", "dev_1", "a.txt")
	if err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(filepath.Dir(p))
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".put-") {
			t.Fatalf("temp file %s left behind", e.Name())
		}
	}
}
