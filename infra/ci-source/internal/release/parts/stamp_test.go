package parts

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// fakeELF is the start of an ELF file with the given machine type, followed
// by the stamped strings.
func fakeELF(machine byte, tail string) []byte {
	h := make([]byte, 64)
	copy(h, "\x7fELF")
	h[18] = machine
	return append(h, tail...)
}

func TestCheckStampScriptArch(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	dir := t.TempDir()
	run := func(machine byte, arch string) error {
		bin := filepath.Join(dir, "bin")
		if err := os.WriteFile(bin, fakeELF(machine, "1.2.3 abc123 2026-01-01"), 0o755); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command("sh", "-c", checkStampScript, "sh", bin, "1.2.3", "abc123", "2026-01-01", dir, "x")
		cmd.Env = append(os.Environ(), "EXPECT_ARCH="+arch)
		out, err := cmd.CombinedOutput()
		if err != nil && !strings.Contains(string(out), "stamp check") {
			t.Fatalf("unexpected output: %s", out)
		}
		return err
	}
	for _, c := range []struct {
		machine byte
		arch    string
		ok      bool
	}{
		{0x3e, "amd64", true},
		{0xb7, "arm64", true},
		{0xb7, "amd64", false},
		{0x3e, "arm64", false},
	} {
		if err := run(c.machine, c.arch); (err == nil) != c.ok {
			t.Errorf("machine %#x as %s: err=%v, want ok=%v", c.machine, c.arch, err, c.ok)
		}
	}
}
