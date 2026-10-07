package parts

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

// The node_modules "already installed" key includes the node image, so a new
// Node reinstalls instead of reusing modules the old one installed.
func TestNodeBuildScriptKeyedByImage(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("no sh")
	}
	tmp := t.TempDir()
	app := filepath.Join(tmp, "app")
	bin := filepath.Join(tmp, "bin")
	log := filepath.Join(tmp, "npm.log")
	for _, d := range []string{filepath.Join(app, "node_modules"), bin} {
		os.MkdirAll(d, 0o755)
	}
	os.WriteFile(filepath.Join(app, "package.json"), []byte("{}"), 0o644)
	os.WriteFile(filepath.Join(app, "package-lock.json"), []byte("{}"), 0o644)
	os.WriteFile(filepath.Join(bin, "npm"), []byte("#!/bin/sh\necho \"$1\" >> "+log+"\n[ \"$1 $2\" = \"run build\" ] && { mkdir -p dist; touch dist/index.html; }\nexit 0\n"), 0o755)
	run := func(img string) {
		t.Helper()
		cmd := exec.Command("sh", "-c", nodeBuildScript, "sh", filepath.Join(app, "dist"), app, "", img)
		cmd.Env = append(os.Environ(), "PATH="+bin+":"+os.Getenv("PATH"))
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("%v: %s", err, out)
		}
	}
	installs := func() int {
		b, _ := os.ReadFile(log)
		return strings.Count(string(b), "ci\n")
	}
	run("libreserv-release/node:aaa")
	run("libreserv-release/node:aaa")
	if n := installs(); n != 1 {
		t.Fatalf("same image installed %d times, want 1", n)
	}
	run("libreserv-release/node:bbb")
	if n := installs(); n != 2 {
		t.Fatalf("a new node image must reinstall; installs = %d", n)
	}
}

func TestNodeImageRefInSpecs(t *testing.T) {
	imgs := t.TempDir()
	os.MkdirAll(filepath.Join(imgs, "node"), 0o755)
	os.WriteFile(filepath.Join(imgs, "node", "Containerfile"), []byte("FROM scratch\n"), 0o644)
	e, err := engine.New(engine.Config{CacheDir: t.TempDir(), ImagesDir: imgs})
	if err != nil {
		t.Fatal(err)
	}
	b := lunaCtx(t, "luna", "0.4.1")
	b.Engine = e
	img, err := e.LoadImage("node")
	if err != nil {
		t.Fatal(err)
	}
	spec := viteBuild(b, "k", "app", "app/dist", t.TempDir(), false)
	if got := spec.Cmd[len(spec.Cmd)-1]; got != img.Ref() {
		t.Errorf("vite build gets node image %q, want %q", got, img.Ref())
	}
	web, err := lunaWebSpec(b)
	if err != nil {
		t.Fatal(err)
	}
	if web.Env["NODE_IMAGE"] != img.Ref() {
		t.Errorf("luna web NODE_IMAGE = %q, want %q", web.Env["NODE_IMAGE"], img.Ref())
	}
}
