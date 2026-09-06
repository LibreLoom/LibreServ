package network

import (
	"os"
	"path/filepath"
	"testing"
)

func TestFrpcDownloadIsELF(t *testing.T) {
	dir := t.TempDir()
	elfPath := filepath.Join(dir, "elf")
	if err := os.WriteFile(elfPath, append([]byte{0x7f, 'E', 'L', 'F'}, make([]byte, minFrpcBytes)...), 0o644); err != nil {
		t.Fatal(err)
	}
	if !frpcDownloadIsELF(elfPath) {
		t.Fatal("expected ELF magic to pass")
	}

	scriptPath := filepath.Join(dir, "script")
	if err := os.WriteFile(scriptPath, []byte("#!/bin/sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if frpcDownloadIsELF(scriptPath) {
		t.Fatal("shell script must not look like ELF")
	}
}

func TestFrpcInstallRejectsNonELFExtract(t *testing.T) {
	// Directly exercise the integrity gate used after extract.
	dir := t.TempDir()
	bad := filepath.Join(dir, "frpc")
	payload := append([]byte("not-an-elf"), make([]byte, minFrpcBytes)...)
	if err := os.WriteFile(bad, payload, 0o755); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(bad)
	if err != nil {
		t.Fatal(err)
	}
	if info.Size() < minFrpcBytes {
		t.Fatal("fixture too small for size gate")
	}
	if frpcDownloadIsELF(bad) {
		t.Fatal("non-ELF fixture should fail integrity")
	}
}
