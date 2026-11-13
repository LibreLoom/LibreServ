package parts

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
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
	// The packs are built before the rootfs and mounted into it: they are part
	// of the image, not of the installer ISO.
	want := map[string][]string{
		"luna/os:hash":                   nil,
		"luna/os:rootfs":                 {"luna/os:hash", "luna/lunad", "luna/installer:pack-eurooffice", "luna/installer:pack-drawio"},
		"luna/os:image":                  {"luna/os:rootfs"},
		"luna/os":                        {"luna/os:image"},
		"luna/installer:live":            {"luna/os:hash"},
		"luna/installer:iso":             {"luna/installer:live", "luna/os"},
		"luna/installer:pack-eurooffice": {"luna/os:hash"},
		"luna/installer:pack-drawio":     {"luna/os:hash"},
		"luna/installer":                 {"luna/installer:iso"},
	}
	heavy := map[string]bool{"luna/os:rootfs": true, "luna/os:image": true, "luna/installer:live": true, "luna/installer:iso": true, "luna/installer:pack-eurooffice": true}
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
	// There is no "reuse the last release's file" case any more: every release
	// builds its own image, so only a local cache of identical inputs can
	// stand in for a build.
	for _, tc := range []struct {
		name string
		in   decideIn
		want osAction
	}{
		{"named wins over the cache", decideIn{force: true, cached: true}, osBuild},
		{"cached", decideIn{cached: true}, osCached},
		{"nothing", decideIn{}, osBuild},
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
	// a pack changes the key through what it is made from
	kp, _ := installerKey(dir, "os1", map[string]string{"drawio": "aa"})
	if kq, _ := installerKey(dir, "os1", map[string]string{"drawio": "bb"}); kq == kp {
		t.Fatal("a new pack must change the key")
	}
	if kq, _ := installerKey(dir, "os1", map[string]string{"drawio": "aa", "eurooffice": "cc"}); kq == kp {
		t.Fatal("another pack must change the key")
	}
	// a file the ISO needs is missing: refuse, do not hash around it
	os.Remove(filepath.Join(dir, "lib", "console.sh"))
	if _, err := installerKey(dir, "os1", nil); err == nil {
		t.Fatal("missing installer file accepted")
	}
}

func TestOSImageKeyFollowsPacks(t *testing.T) {
	k1 := osImageKey("os1", map[string]string{"eurooffice": "aa", "drawio": "bb"})
	if k2 := osImageKey("os1", map[string]string{"drawio": "bb", "eurooffice": "aa"}); k2 != k1 {
		t.Fatal("key depends on map order")
	}
	if k2 := osImageKey("os2", map[string]string{"eurooffice": "aa", "drawio": "bb"}); k2 == k1 {
		t.Fatal("a new OS input hash must change the key")
	}
	if k2 := osImageKey("os1", map[string]string{"eurooffice": "aa", "drawio": "cc"}); k2 == k1 {
		t.Fatal("a changed pack must change the image key")
	}
}

func sum(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func TestFinishFile(t *testing.T) {
	b := lunaCtx(t, "luna", "0.4.1")
	out := b.PartOutDir("os")
	os.MkdirAll(out, 0o755)
	os.WriteFile(filepath.Join(out, OSFile), []byte("img"), 0o644)

	// build: records the inputs, stores a copy
	if err := finishFile(b, t.Logf, "os", OSFile, "luna-os", "key1", osBuild, osSidecars(OSFile)); err != nil {
		t.Fatal(err)
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
	hash := osHashSpec(b, t.TempDir())
	hashArgs := strings.Join(e.RunArgs(img, hash, "hash"), " ")
	if !strings.Contains(hashArgs, filepath.Join(b.SrcDir, "shared", "scripts")+":/shared/scripts:ro") {
		t.Fatalf("OS input hashing cannot read the shared packaging helper: %s", hashArgs)
	}
	image, err := osImageSpec(b)
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
	check("rootfs", rootfs, "luna-os", osdir, filepath.Join(b.SrcDir, "shared", "scripts")+":/shared/scripts:ro", engine.VolumePrefix+"luna-os-rootfs:/rootfs", engine.VolumePrefix+"luna-os-cache:/cache", "/in/lunad:ro", "/in/console:ro", "/in/packs:ro", "LUNAD_BIN")
	check("image", image, "luna-os", osdir, engine.VolumePrefix+"luna-os-rootfs:/rootfs", b.PartOutDir("os")+":/out")
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

func packCtx(t *testing.T, released bool) *engine.BuildContext {
	t.Helper()
	eng, err := engine.New(engine.Config{Repo: t.TempDir(), CacheDir: t.TempDir(), ImagesDir: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	b := &engine.BuildContext{Engine: eng, Unit: "luna", Version: "1.0.0", SrcDir: t.TempDir(), OutRoot: t.TempDir()}
	if released {
		b.Released = func(string) (engine.Released, bool) { return engine.Released{}, false }
	}
	for _, d := range packDefs {
		for _, rel := range d.inputs {
			writeTree(t, b.SrcDir, map[string]string{rel: "x"})
		}
	}
	return b
}

func TestPackKeyFollowsPins(t *testing.T) {
	t.Setenv("LUNA_PACKS_DIR", "")
	b := packCtx(t, false)
	d := packDefs[1]
	k1, err := packKey(b, d)
	if err != nil {
		t.Fatal(err)
	}
	writeTree(t, b.SrcDir, map[string]string{"luna/scripts/install-drawio-assets.sh": "new pin"})
	if k2, _ := packKey(b, d); k2 == k1 {
		t.Fatal("a changed upstream pin must change the pack key")
	}
	if packCurrent(b, d, k1) {
		t.Fatal("pack current before it exists")
	}
	dir := packsDir(b)
	writeTree(t, dir, map[string]string{d.file: "z", d.file + ".sha256": "h  " + d.file, d.file + ".key": k1 + "\n"})
	if !packCurrent(b, d, k1) || packCurrent(b, d, "other") {
		t.Fatal("packCurrent does not follow the key file")
	}
}

func TestMissingPacksFailCutsOnly(t *testing.T) {
	t.Setenv("LUNA_PACKS_DIR", "")
	var logs []string
	logf := func(f string, a ...any) { logs = append(logs, fmt.Sprintf(f, a...)) }
	if err := checkPacks(packCtx(t, false), logf); err != nil || len(logs) != 2 {
		t.Fatalf("dev build: err %v, logs %v", err, logs)
	}
	b := packCtx(t, true)
	if err := checkPacks(b, logf); err == nil || !strings.Contains(err.Error(), "eurooffice-pack.tar.zst") {
		t.Fatalf("cut without packs: %v", err)
	}
	for _, d := range packDefs {
		writeTree(t, packsDir(b), map[string]string{d.file: "z", d.file + ".sha256": "h"})
	}
	if err := checkPacks(b, logf); err != nil {
		t.Fatal(err)
	}
}

// A cut must not reuse a cached image that carries a dev lunad.
func TestCachedImageForCutNeedsReleaseLunad(t *testing.T) {
	dev := lunaCtx(t, "luna", "0.4.1-0.dev.12")
	out := dev.PartOutDir("os")
	os.MkdirAll(out, 0o755)
	os.WriteFile(filepath.Join(out, OSFile), []byte("img"), 0o644)
	if err := finishFile(dev, t.Logf, "os", OSFile, "luna-os", "k", osBuild, osSidecars(OSFile)); err != nil {
		t.Fatal(err)
	}
	if err := recordLunadVersion(dev, "luna-os", "k", dev.Version); err != nil {
		t.Fatal(err)
	}
	cut := lunaCtx(t, "luna", "0.4.1")
	cut.Engine = dev.Engine
	cut.Released = func(string) (engine.Released, bool) { return engine.Released{}, false }
	if !cacheUsable(dev, "luna-os", "k", OSFile) {
		t.Error("a dev build must keep reusing its own cached image")
	}
	if cacheUsable(cut, "luna-os", "k", OSFile) {
		t.Error("a cut reused an image built with a dev lunad")
	}
	if err := recordLunadVersion(cut, "luna-os", "k", "0.4.0"); err != nil {
		t.Fatal(err)
	}
	if !cacheUsable(cut, "luna-os", "k", OSFile) {
		t.Error("a cut must reuse an image built with a release lunad")
	}
	forgetLunadVersion(cut, "luna-os", "k")
	if cacheUsable(cut, "luna-os", "k", OSFile) {
		t.Error("a cut reused an image with no recorded lunad version")
	}
}
