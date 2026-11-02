package network

import (
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func socketTestBase(t *testing.T) string {
	t.Helper()
	base := os.Getenv("XDG_RUNTIME_DIR")
	if base == "" {
		if os.Geteuid() == 0 {
			base = "/run"
		} else {
			base = filepath.Join("/run/user", strconv.Itoa(os.Geteuid()))
		}
	}
	return base
}

func TestTailscaleSocketGenerationsRemainPrivate(t *testing.T) {
	base := socketTestBase(t)
	dir, err := os.MkdirTemp(base, "ts-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	dir, err = filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	a, first, err := BindTailscaleSocket(dir)
	if err != nil {
		t.Fatal(err)
	}
	b, second, err := BindTailscaleSocket(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	if first == second {
		t.Fatal("reused a generation")
	}
	for path, mode := range map[string]os.FileMode{filepath.Dir(first): 0700, first: 0600} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != mode {
			t.Fatalf("%s: %v %v", path, info, err)
		}
	}
	a.Close()
	if c, err := net.Dial("unix", first); err == nil {
		c.Close()
		t.Fatal("stale target still accepts")
	}
	c, err := net.Dial("unix", second)
	if err != nil {
		t.Fatal(err)
	}
	c.Close()
}
func TestTailscaleSocketRejectsSymlinkAndLongPath(t *testing.T) {
	base := socketTestBase(t)
	dir, err := os.MkdirTemp(base, "ts-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	dir, err = filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(t.TempDir(), filepath.Join(dir, "ts")); err != nil {
		t.Fatal(err)
	}
	if l, _, err := BindTailscaleSocket(dir); err == nil {
		l.Close()
		t.Fatal("accepted symlink")
	}
	long := filepath.Join(dir, strings.Repeat("x", 90))
	if err := os.Mkdir(long, 0700); err != nil {
		t.Fatal(err)
	}
	if l, _, err := BindTailscaleSocket(long); err == nil {
		l.Close()
		t.Fatal("accepted long socket path")
	}
}

func TestTailscaleSocketRejectsWritableAncestor(t *testing.T) {
	base := socketTestBase(t)
	parent, err := os.MkdirTemp(base, "ts-parent-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(parent) })
	parent, err = filepath.Abs(parent)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(parent, 0777); err != nil {
		t.Fatal(err)
	}
	data := filepath.Join(parent, "data")
	if err := os.Mkdir(data, 0700); err != nil {
		t.Fatal(err)
	}
	if l, _, err := BindTailscaleSocket(data); err == nil {
		l.Close()
		t.Fatal("accepted writable ancestor")
	}
}
