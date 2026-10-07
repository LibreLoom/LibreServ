package parts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

func osParts() []engine.Part { return []engine.Part{&Lunad{}, For("luna")[1], For("luna")[2]} }

func TestOSRegistered(t *testing.T) {
	var names []string
	for _, p := range For("luna") {
		names = append(names, p.Name())
	}
	if strings.Join(names, ",") != "lunad,os,installer" {
		t.Fatalf("luna parts %v", names)
	}
	if OSFile != "luna-os-x86_64.img.xz" || InstallerFile != "luna-rapidinstall-x86_64.iso.xz" {
		t.Fatal(OSFile, InstallerFile)
	}
}

func TestOSGraph(t *testing.T) {
	b := lunaCtx(t, "luna", "0.4.1-0.dev.12")
	g, err := engine.BuildGraph(b, osParts())
	if err != nil {
		t.Fatal(err)
	}
	want := map[string][]string{
		"luna/os:hash":        nil,
		"luna/os:rootfs":      {"luna/os:hash", "luna/lunad"},
		"luna/os:image":       {"luna/os:rootfs"},
		"luna/os":             {"luna/os:image"},
		"luna/installer:live": {"luna/os:hash"},
		"luna/installer:iso":  {"luna/installer:live", "luna/os"},
		"luna/installer":      {"luna/installer:iso"},
	}
	heavy := map[string]bool{"luna/os:rootfs": true, "luna/os:image": true, "luna/installer:live": true, "luna/installer:iso": true}
	got := map[string][]string{}
	for _, j := range g.Jobs() {
		if !strings.HasPrefix(j.ID, "luna/os") && !strings.HasPrefix(j.ID, "luna/installer") {
			continue
		}
		got[j.ID] = j.Deps
		if j.Heavy != heavy[j.ID] {
			t.Errorf("%s heavy=%v", j.ID, j.Heavy)
		}
	}
	if len(got) != len(want) {
		t.Fatalf("jobs %v", got)
	}
	for id, deps := range want {
		if strings.Join(got[id], ",") != strings.Join(deps, ",") {
			t.Errorf("%s deps %v, want %v", id, got[id], deps)
		}
	}
}

func TestDecide(t *testing.T) {
	same := func() (string, error) { return "h1", nil }
	other := func() (string, error) { return "h0", nil }
	broken := func() (string, error) { return "", errors.New("HTTP 404") }
	for _, tc := range []struct {
		name string
		in   decideIn
		want osAction
	}{
		{"same as the release", decideIn{hash: "h1", released: same, releasedVersion: "0.4.0"}, osReuse},
		{"same as the release, also cached", decideIn{hash: "h1", released: same, cached: true}, osReuse},
		{"named wins over the release", decideIn{force: true, hash: "h1", released: same}, osBuild},
		{"named wins over the cache", decideIn{force: true, hash: "h1", cached: true}, osBuild},
		{"changed, cached", decideIn{hash: "h1", released: other, cached: true}, osCached},
		{"changed, not cached", decideIn{hash: "h1", released: other}, osBuild},
		{"release unreadable", decideIn{hash: "h1", released: broken}, osBuild},
		{"release unreadable, cached", decideIn{hash: "h1", released: broken, cached: true}, osCached},
		{"dev build, cached", decideIn{hash: "h1", cached: true}, osCached},
		{"dev build, nothing", decideIn{hash: "h1"}, osBuild},
	} {
		got, why := decide(tc.in)
		if got != tc.want || why == "" {
			t.Errorf("%s: %v (%q), want %v", tc.name, got, why, tc.want)
		}
	}
}

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, body := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func isoTree() map[string]string {
	m := map[string]string{"debian-live/config/hooks/0100.hook.chroot": "a", "iso/find-media.sh": "b", "rapidinstall.sh": "c"}
	for _, f := range []string{"disk", "flash-disk", "console", "factory-assets"} {
		m["lib/"+f+".sh"] = f
	}
	for _, f := range []string{"iso", "live", "iso-customize"} {
		m["build/"+f+".sh"] = f
	}
	m["build/Containerfile.iso"] = "FROM x"
	return m
}

func TestInstallerKey(t *testing.T) {
	dir := t.TempDir()
	writeTree(t, dir, isoTree())
	k1, err := installerKey(dir, "os1", nil)
	if err != nil {
		t.Fatal(err)
	}
	if k2, _ := installerKey(dir, "os1", nil); k2 != k1 {
		t.Fatal("key is not stable")
	}
	if k2, _ := installerKey(dir, "os2", nil); k2 == k1 {
		t.Fatal("a new OS hash must change the key")
	}
	writeTree(t, dir, map[string]string{"rapidinstall.sh": "changed"})
	k3, _ := installerKey(dir, "os1", nil)
	if k3 == k1 {
		t.Fatal("the installer script must change the key")
	}
	writeTree(t, dir, map[string]string{"debian-live/config/package-lists/new.list.chroot": "vim"})
	if k4, _ := installerKey(dir, "os1", nil); k4 == k3 {
		t.Fatal("a new live package list must change the key")
	}
	// a pack changes the key through its sha256 file
	pack := filepath.Join(t.TempDir(), "drawio-pack.tar.zst")
	writeTree(t, filepath.Dir(pack), map[string]string{"drawio-pack.tar.zst": "z", "drawio-pack.tar.zst.sha256": "aa  drawio-pack.tar.zst"})
	kp, _ := installerKey(dir, "os1", []string{pack, pack + ".sha256"})
	writeTree(t, filepath.Dir(pack), map[string]string{"drawio-pack.tar.zst.sha256": "bb  drawio-pack.tar.zst"})
	if kq, _ := installerKey(dir, "os1", []string{pack, pack + ".sha256"}); kq == kp {
		t.Fatal("a new pack must change the key")
	}
	// a file the ISO needs is missing: refuse, do not hash around it
	os.Remove(filepath.Join(dir, "lib", "console.sh"))
	if _, err := installerKey(dir, "os1", nil); err == nil {
		t.Fatal("missing installer file accepted")
	}
}

func sum(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func TestFetchInputsAndReleased(t *testing.T) {
	img := "pretend this is an xz image"
	mux := http.NewServeMux()
	mux.HandleFunc("/f/luna-os-x86_64.img.xz.inputs", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("abc123\n")) })
	mux.HandleFunc("/f/luna-os-x86_64.img.xz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(img)) })
	mux.HandleFunc("/f/bad.img.xz", func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("something else")) })
	srv := httptest.NewServer(mux)
	defer srv.Close()
	ctx := context.Background()

	if got, err := fetchInputs(ctx, srv.URL+"/f/luna-os-x86_64.img.xz"); err != nil || got != "abc123" {
		t.Fatalf("fetchInputs %q %v", got, err)
	}
	if _, err := fetchInputs(ctx, srv.URL+"/f/missing"); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("missing inputs: %v", err)
	}

	b := lunaCtx(t, "luna", "0.4.1")
	rel := engine.Released{Version: "0.4.0", URL: srv.URL + "/f/luna-os-x86_64.img.xz", SHA256: sum(img), Size: int64(len(img))}
	p, err := fetchReleased(ctx, b, t.Logf, rel)
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(p); string(got) != img {
		t.Fatalf("downloaded %q", got)
	}
	// second call hits the cache: the server may be gone
	srv.Close()
	if p2, err := fetchReleased(ctx, b, t.Logf, rel); err != nil || p2 != p {
		t.Fatalf("cached fetch %q %v", p2, err)
	}
}

func TestFetchReleasedRejectsWrongBytes(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte("tampered")) }))
	defer srv.Close()
	b := lunaCtx(t, "luna", "0.4.1")
	rel := engine.Released{Version: "0.4.0", URL: srv.URL + "/x", SHA256: sum("the real image")}
	_, err := fetchReleased(context.Background(), b, t.Logf, rel)
	if err == nil || !strings.Contains(err.Error(), "does not match the feed") {
		t.Fatalf("err %v", err)
	}
	if left, _ := filepath.Glob(filepath.Join(b.Engine.CacheDir(), "luna-released", "*")); len(left) != 0 {
		t.Fatalf("a rejected download was kept: %v", left)
	}
	if _, err := fetchReleased(context.Background(), b, t.Logf, engine.Released{URL: srv.URL}); err == nil {
		t.Fatal("a release without a sha256 was accepted")
	}
}

func TestFinishFile(t *testing.T) {
	b := lunaCtx(t, "luna", "0.4.1")
	out := b.PartOutDir("os")
	os.MkdirAll(out, 0o755)
	os.WriteFile(filepath.Join(out, OSFile), []byte("img"), 0o644)

	// build: records the inputs, stores a copy
	if err := finishFile(b, t.Logf, "os", OSFile, "luna-os", "key1", osBuild, osSidecars(OSFile)); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(out, OSFile+InputsSuffix)); string(got) != "key1\n" {
		t.Fatalf("inputs %q", got)
	}
	if !cacheHas(b, "luna-os", "key1", OSFile) {
		t.Fatal("not cached")
	}
	// a newer build replaces the cached older one
	os.WriteFile(filepath.Join(out, OSFile), []byte("img2"), 0o644)
	if err := finishFile(b, t.Logf, "os", OSFile, "luna-os", "key2", osBuild, osSidecars(OSFile)); err != nil {
		t.Fatal(err)
	}
	if cacheHas(b, "luna-os", "key1", OSFile) || !cacheHas(b, "luna-os", "key2", OSFile) {
		t.Fatal("cache keeps more than the newest")
	}
	// cached: a fresh build dir gets the file and its inputs
	b2 := lunaCtx(t, "luna", "0.4.2")
	b2.Engine = b.Engine
	if err := finishFile(b2, t.Logf, "os", OSFile, "luna-os", "key2", osCached, osSidecars(OSFile)); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.ReadFile(filepath.Join(b2.PartOutDir("os"), OSFile)); string(got) != "img2" {
		t.Fatalf("linked %q", got)
	}
	if _, err := os.Stat(filepath.Join(b2.PartOutDir("os"), OSFile+InputsSuffix)); err != nil {
		t.Fatal(err)
	}
	// reuse: nothing is produced
	b3 := lunaCtx(t, "luna", "0.4.3")
	if err := finishFile(b3, t.Logf, "os", OSFile, "luna-os", "key2", osReuse, osSidecars(OSFile)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(b3.PartOutDir("os"), OSFile)); err == nil {
		t.Fatal("reuse produced a file")
	}
	// build that produced nothing is an error
	b4 := lunaCtx(t, "luna", "0.4.4")
	if err := finishFile(b4, t.Logf, "os", OSFile, "luna-os", "key3", osBuild, osSidecars(OSFile)); err == nil {
		t.Fatal("missing output accepted")
	}
}

func TestOSSpecs(t *testing.T) {
	b := lunaCtx(t, "luna", "0.4.1-0.dev.12")
	e := b.Engine
	img := engine.Image{Name: "x", Hash: "h"}

	if _, err := osRootfsSpec(b); err == nil {
		t.Fatal("rootfs spec without lunad accepted")
	}
	for _, p := range []string{filepath.Join(b.PartOutDir("lunad"), LunadFile), LunaConsolePath(b)} {
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte("bin"), 0o755)
	}
	rootfs, err := osRootfsSpec(b)
	if err != nil {
		t.Fatal(err)
	}
	image, err := osImageSpec(b, "deadbeef")
	if err != nil {
		t.Fatal(err)
	}
	payload := t.TempDir()
	iso, err := instISOSpec(b, payload)
	if err != nil {
		t.Fatal(err)
	}
	live := instLiveSpec(b)

	check := func(name string, spec engine.RunSpec, image string, wants ...string) {
		t.Helper()
		if spec.Image != image {
			t.Errorf("%s image %s", name, spec.Image)
		}
		args := strings.Join(e.RunArgs(img, spec, "n"), " ")
		for _, w := range append(wants, "--memory 3g", "--security-opt label=disable") {
			if !strings.Contains(args, w) {
				t.Errorf("%s lacks %q:\n%s", name, w, args)
			}
		}
		for _, bad := range []string{"--privileged", "sudo"} {
			if strings.Contains(args, bad) {
				t.Errorf("%s uses %s", name, bad)
			}
		}
	}
	os.MkdirAll(filepath.Join(b.SrcDir, "luna", "os"), 0o755)
	osdir := filepath.Join(b.SrcDir, "luna", "os") + ":/luna/os:ro"
	check("rootfs", rootfs, "luna-os", osdir, engine.VolumePrefix+"luna-os-rootfs:/rootfs", engine.VolumePrefix+"luna-os-cache:/cache", "/in/lunad:ro", "/in/console:ro", "LUNAD_BIN")
	check("image", image, "luna-os", osdir, engine.VolumePrefix+"luna-os-rootfs:/rootfs", b.PartOutDir("os")+":/out", "OS_INPUT_HASH")
	check("live", live, "luna-iso", osdir, engine.VolumePrefix+"luna-iso-cache:/cache", "LIVE_ONLY")
	check("iso", iso, "luna-iso", osdir, payload+":/payload:ro", b.PartOutDir("installer")+":/out", engine.VolumePrefix+"luna-iso-cache:/cache")
	if strings.Join(rootfs.Cmd, " ") != "sh /luna/os/build/rootfs.sh" || strings.Join(image.Cmd, " ") != "sh /luna/os/build/image.sh" ||
		strings.Join(live.Cmd, " ") != "sh /luna/os/build/iso.sh" {
		t.Errorf("commands %v %v %v", rootfs.Cmd, image.Cmd, live.Cmd)
	}
	// the toolchain images are the repo's own Containerfiles, not copies
	for _, n := range []string{"luna-os", "luna-iso"} {
		root := repoRoot(t)
		img, err := engine.LoadImage(filepath.Join(root, "infra", "release", "images"), n)
		if err != nil {
			t.Fatal(err)
		}
		cf := "Containerfile.os"
		if n == "luna-iso" {
			cf = "Containerfile.iso"
		}
		want, _ := os.ReadFile(filepath.Join(root, "luna", "os", "build", cf))
		got, _ := os.ReadFile(filepath.Join(img.Dir, "Containerfile"))
		if string(got) != string(want) {
			t.Errorf("%s differs from luna/os/build/%s", n, cf)
		}
	}
}

func TestOSScriptsParse(t *testing.T) {
	for _, f := range []string{"os-hash.sh", "os-iso.sh"} {
		if lunaScript(f) == "" {
			t.Fatal(f)
		}
	}
}
