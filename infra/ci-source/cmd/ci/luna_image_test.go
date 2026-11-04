package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

// Exercise the actual Containerfile selection with each image architecture.
func TestLunaRustupArchitecture(t *testing.T) {
	contents, err := os.ReadFile("../../images/luna-ci/Containerfile")
	if err != nil {
		t.Fatal(err)
	}
	text := string(contents)
	start := strings.Index(text, `RUN case "$(dpkg --print-architecture)"`)
	if start < 0 {
		t.Fatal("rustup architecture selection missing")
	}
	end := strings.Index(text[start:], "    && curl --proto")
	if end < 0 {
		t.Fatal("rustup architecture selection missing")
	}
	selection := strings.ReplaceAll(text[start+4:start+end], "\\\n", "")
	for _, tc := range []struct{ arch, want string }{
		{"amd64", "x86_64 dda7234360b7f578ca8b0ddcb80145646fa61a67c1720a5abc7051b35c9fcb71"},
		{"arm64", "aarch64 15f6e4ce9f583b929c996c91562bad6d4454f3281de858b02cdfdef615fac433"},
		{"unsupported", ""},
	} {
		t.Run(tc.arch, func(t *testing.T) {
			script := "dpkg() { printf '%s' " + tc.arch + "; }; " + selection + `; printf '%s %s' "$rust_arch" "$rust_sha"`
			out, err := exec.Command("sh", "-c", script).CombinedOutput()
			if tc.want == "" {
				if err == nil || !strings.Contains(string(out), "Unsupported image architecture") {
					t.Fatalf("unsupported architecture: output %q, error %v", out, err)
				}
			} else if err != nil || string(out) != tc.want {
				t.Fatalf("got %q, error %v; want %q", out, err, tc.want)
			}
		})
	}
}
