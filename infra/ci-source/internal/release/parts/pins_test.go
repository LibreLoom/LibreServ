package parts

import (
	"os"
	"path/filepath"
	"regexp"
	"testing"
)

// The luna-os and luna-iso toolchain images are built by the engine without
// build arguments, so the base image in each Containerfile is the pin. It must
// be a digest, and the dev wrappers' default must be the same one.
func TestOSBasesPinnedByDigest(t *testing.T) {
	root := filepath.Join("..", "..", "..", "..", "..")
	read := func(rel string) string {
		b, err := os.ReadFile(filepath.Join(root, rel))
		if err != nil {
			t.Skip("repo files not available: ", err)
		}
		return string(b)
	}
	pin := regexp.MustCompile(`docker\.io/library/(?:alpine|debian)@sha256:[0-9a-f]{64}`)
	osPin := pin.FindString(read("luna/os/build/Containerfile.os"))
	if osPin == "" {
		t.Fatal("Containerfile.os base is not pinned by digest")
	}
	if got := pin.FindString(read("luna/os/lib/alpine-image.sh")); got != osPin {
		t.Fatalf("lib/alpine-image.sh pins %q, Containerfile.os pins %q", got, osPin)
	}
	isoPin := pin.FindString(read("luna/os/build/Containerfile.iso"))
	if isoPin == "" {
		t.Fatal("Containerfile.iso base is not pinned by digest")
	}
	if got := pin.FindString(read("luna/os/make-iso.sh")); got != isoPin {
		t.Fatalf("make-iso.sh pins %q, Containerfile.iso pins %q", got, isoPin)
	}
}

// The engine builds those images without build arguments, so an ALPINE_IMAGE
// override would change the input hash without reaching the build.
func TestOSEnvDoesNotForwardImageOverrides(t *testing.T) {
	t.Setenv("ALPINE_IMAGE", "docker.io/library/alpine:3.99")
	t.Setenv("SIZE_MB", "512")
	env := osEnv()
	if _, ok := env["ALPINE_IMAGE"]; ok {
		t.Fatal("osEnv forwards ALPINE_IMAGE")
	}
	if env["SIZE_MB"] != "512" {
		t.Fatal("osEnv lost SIZE_MB")
	}
}
