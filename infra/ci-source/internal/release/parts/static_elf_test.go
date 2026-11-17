package parts

import (
	"debug/elf"
	"encoding/binary"
	"os"
	"path/filepath"
	"testing"
)

func TestValidateStaticReleaseELF(t *testing.T) {
	for _, tc := range []struct {
		name, arch string
		machine    elf.Machine
		kind       elf.Type
		interp     bool
		valid      bool
	}{
		{"amd64", "amd64", elf.EM_X86_64, elf.ET_EXEC, false, true},
		{"arm64", "arm64", elf.EM_AARCH64, elf.ET_EXEC, false, true},
		{"static pie", "amd64", elf.EM_X86_64, elf.ET_DYN, false, true},
		{"wrong architecture", "arm64", elf.EM_X86_64, elf.ET_EXEC, false, false},
		{"unknown architecture", "other", elf.EM_X86_64, elf.ET_EXEC, false, false},
		{"object file", "amd64", elf.EM_X86_64, elf.ET_REL, false, false},
		{"dynamic executable", "amd64", elf.EM_X86_64, elf.ET_EXEC, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "binary")
			f, err := os.Create(path)
			if err != nil {
				t.Fatal(err)
			}
			h := elf.Header64{
				Ident: [elf.EI_NIDENT]byte{0x7f, 'E', 'L', 'F', byte(elf.ELFCLASS64), byte(elf.ELFDATA2LSB), byte(elf.EV_CURRENT)},
				Type:  uint16(tc.kind), Machine: uint16(tc.machine), Version: 1,
				Ehsize: 64, Phoff: 64, Phentsize: 56, Phnum: 1,
			}
			prog := elf.Prog64{Type: uint32(elf.PT_LOAD)}
			if tc.interp {
				prog.Type = uint32(elf.PT_INTERP)
			}
			if err := binary.Write(f, binary.LittleEndian, h); err != nil {
				t.Fatal(err)
			}
			if err := binary.Write(f, binary.LittleEndian, prog); err != nil {
				t.Fatal(err)
			}
			if err := f.Close(); err != nil {
				t.Fatal(err)
			}
			if err := validateStaticELF(path, tc.arch); (err == nil) != tc.valid {
				t.Fatalf("valid=%v, error=%v", tc.valid, err)
			}
		})
	}
	bad := filepath.Join(t.TempDir(), "bad")
	if err := os.WriteFile(bad, []byte("not an ELF"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := validateStaticELF(bad, "amd64"); err == nil {
		t.Fatal("accepted a broken artifact")
	}
}
