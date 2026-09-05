package network

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCloudflaredDownloadIsELF(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "script")
	if err := os.WriteFile(script, []byte("#!/bin/sh\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if cloudflaredDownloadIsELF(script) {
		t.Fatal("script must not look like ELF")
	}
	elfish := filepath.Join(dir, "elf")
	if err := os.WriteFile(elfish, []byte{0x7f, 'E', 'L', 'F', 0, 0, 0, 0}, 0o644); err != nil {
		t.Fatal(err)
	}
	if !cloudflaredDownloadIsELF(elfish) {
		t.Fatal("ELF magic should pass")
	}
}

func TestCloudflaredReleasePin(t *testing.T) {
	if cloudflaredRelease == "" || strings.Contains(cloudflaredRelease, "latest") {
		t.Fatalf("expected pinned release, got %q", cloudflaredRelease)
	}
}
