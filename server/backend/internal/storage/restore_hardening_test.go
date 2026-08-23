package storage

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateRestoredTreeRejectsSymlink(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "data"), 0750); err != nil {
		t.Fatal(err)
	}
	// Symlink pointing outside the root — must be rejected outright.
	if err := os.Symlink("/etc", filepath.Join(root, "data", "escape")); err != nil {
		t.Fatal(err)
	}
	err := validateRestoredTree(root)
	if err == nil {
		t.Fatal("expected error for tree containing a symlink")
	}
	if !strings.Contains(err.Error(), "symlink") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestValidateRestoredTreeRejectsInRootSymlink(t *testing.T) {
	// Even a link that stays inside root is rejected: it is a TOCTOU hazard
	// when later os.Rename calls move paths through it.
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "real.txt"), []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "real.txt"), filepath.Join(root, "link.txt")); err != nil {
		t.Fatal(err)
	}
	if err := validateRestoredTree(root); err == nil {
		t.Fatal("expected error for in-root symlink")
	}
}

func TestValidateRestoredTreeAcceptsCleanTree(t *testing.T) {
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "sub"), 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "docker-compose.yml"), []byte("services: {}\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "sub", "file.bin"), []byte{0, 1, 2}, 0600); err != nil {
		t.Fatal(err)
	}
	if err := validateRestoredTree(root); err != nil {
		t.Fatalf("clean tree should pass validation: %v", err)
	}
}

func TestIsSafeRestoreDestination(t *testing.T) {
	parent := t.TempDir()
	cases := []struct {
		dst string
		ok  bool
	}{
		{filepath.Join(parent, "child"), true},
		{filepath.Join(parent, "sub", "grandchild"), true},
		{parent, true},
		// Traversal out of parent must be refused even via .. segments.
		{filepath.Join(parent, "..", "elsewhere"), false},
		{filepath.Join(parent, "..", "..", "etc", "shadow"), false},
		{"/etc/passwd", false},
	}
	for _, c := range cases {
		if got := isSafeRestoreDestination(c.dst, parent); got != c.ok {
			t.Errorf("isSafeRestoreDestination(%q, parent) = %v, want %v", c.dst, got, c.ok)
		}
	}
}

func TestSecureMoveRejectsSymlinkSource(t *testing.T) {
	base := t.TempDir()
	srcDir := filepath.Join(base, "src")
	dstParent := filepath.Join(base, "dst")
	for _, d := range []string{srcDir, dstParent} {
		if err := os.MkdirAll(d, 0750); err != nil {
			t.Fatal(err)
		}
	}
	link := filepath.Join(srcDir, "evil")
	if err := os.Symlink("/etc", link); err != nil {
		t.Fatal(err)
	}
	dst := filepath.Join(dstParent, "evil")
	if err := secureMove(link, dst, dstParent); err == nil {
		t.Fatal("expected secureMove to refuse a symlink source")
	}
	if _, err := os.Lstat(dst); !os.IsNotExist(err) {
		t.Fatal("symlink source must not be moved into destination")
	}
}

func TestSecureMoveRejectsTraversalDestination(t *testing.T) {
	base := t.TempDir()
	src := filepath.Join(base, "srcdir")
	dstParent := filepath.Join(base, "dstparent")
	for _, d := range []string{src, dstParent} {
		if err := os.MkdirAll(d, 0750); err != nil {
			t.Fatal(err)
		}
	}
	payload := filepath.Join(src, "payload.txt")
	if err := os.WriteFile(payload, []byte("x"), 0600); err != nil {
		t.Fatal(err)
	}
	escDst := filepath.Join(dstParent, "..", "escaped.txt")
	if err := secureMove(payload, escDst, dstParent); err == nil {
		t.Fatal("expected secureMove to refuse traversal destination")
	}
	if _, err := os.Stat(filepath.Join(base, "escaped.txt")); !os.IsNotExist(err) {
		t.Fatal("file must not land outside allowed parent")
	}
}

func TestSecureMoveMovesFileAndDirectory(t *testing.T) {
	base := t.TempDir()
	srcDir := filepath.Join(base, "src")
	dstParent := filepath.Join(base, "app")
	if err := os.MkdirAll(filepath.Join(srcDir, "nested"), 0750); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "nested", "f.txt"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(srcDir, "top.txt"), []byte("t"), 0600); err != nil {
		t.Fatal(err)
	}

	dst := filepath.Join(dstParent, "moved")
	if err := secureMove(srcDir, dst, dstParent); err != nil {
		t.Fatalf("secureMove failed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dst, "nested", "f.txt")); err != nil {
		t.Fatalf("nested content missing after move: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dst, "top.txt")); err != nil {
		t.Fatalf("top-level file missing after move: %v", err)
	}
}
