package engine

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// Runs a tiny alpine job through the real runner. Skipped without podman or
// when LIBRESERV_RELEASE_NO_PODMAN_TESTS is set.
func TestRunnerAlpine(t *testing.T) {
	if _, err := exec.LookPath("podman"); err != nil || os.Getenv("LIBRESERV_RELEASE_NO_PODMAN_TESTS") != "" {
		t.Skip("podman not available")
	}
	if err := exec.Command("podman", "info").Run(); err != nil {
		t.Skip("podman not usable: ", err)
	}
	imgs := t.TempDir()
	dir := filepath.Join(imgs, "tiny")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "Containerfile"),
		[]byte("FROM docker.io/library/alpine@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8\nRUN echo tiny-"+t.Name()+" > /etc/tiny\n"), 0o644)

	e, err := New(Config{ImagesDir: imgs, CacheDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	e.Redactor.Add("topsecretvalue")
	src, out := t.TempDir(), t.TempDir()
	os.WriteFile(filepath.Join(src, "in.txt"), []byte("hello\n"), 0o644)

	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Minute)
	defer cancel()
	var mu sync.Mutex
	var lines []string
	log := func(l string) { mu.Lock(); lines = append(lines, l); mu.Unlock() }

	img, err := e.EnsureImage(ctx, "tiny", BuildOpts{}, log)
	if err != nil {
		t.Fatal(err)
	}
	defer exec.Command("podman", "rmi", "-f", img.Ref()).Run()
	defer exec.Command("podman", "volume", "rm", "-f", VolumePrefix+"itest-cache").Run()

	err = e.Run(ctx, RunSpec{
		Name: "itest", Image: "tiny", Source: src, Out: out,
		Caches: []Cache{{"itest-cache", "/cache"}},
		Env:    map[string]string{"SECRET": "topsecretvalue"},
		Memory: "64m",
		Cmd:    []string{"sh", "-c", "cat in.txt; echo $SECRET; echo err >&2; echo built > /out/result.txt; echo x > /cache/f; cat /etc/tiny"},
	}, log)
	if err != nil {
		t.Fatal(err, lines)
	}
	all := strings.Join(lines, "\n")
	if !strings.Contains(all, "hello") || !strings.Contains(all, "err") {
		t.Fatalf("missing output: %q", all)
	}
	if strings.Contains(all, "topsecretvalue") || !strings.Contains(all, "***") {
		t.Fatalf("secret not redacted: %q", all)
	}
	b, err := os.ReadFile(filepath.Join(out, "result.txt"))
	if err != nil || strings.TrimSpace(string(b)) != "built" {
		t.Fatal("output not written", err)
	}

	// Image already built: no rebuild.
	lines = nil
	if _, err := e.EnsureImage(ctx, "tiny", BuildOpts{}, log); err != nil || len(lines) != 0 {
		t.Fatalf("rebuilt: %v %v", err, lines)
	}

	// Non-zero exit.
	err = e.Run(ctx, RunSpec{Name: "fail", Image: "tiny", Cmd: []string{"sh", "-c", "exit 7"}}, log)
	if ee, ok := err.(*ExitError); !ok || ee.Code != 7 {
		t.Fatalf("want ExitError 7, got %v", err)
	}

	// Cancellation kills the container promptly.
	cctx, ccancel := context.WithCancel(ctx)
	go func() { time.Sleep(2 * time.Second); ccancel() }()
	t0 := time.Now()
	err = e.Run(cctx, RunSpec{Name: "sleeper", Image: "tiny", Cmd: []string{"sleep", "120"}}, log)
	if err == nil || time.Since(t0) > 30*time.Second {
		t.Fatalf("cancel: err=%v after %v", err, time.Since(t0))
	}
}
