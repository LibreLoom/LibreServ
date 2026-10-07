package parts

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

func TestFlatpakBundles(t *testing.T) {
	cases := []struct {
		f    Flatpak
		ver  string
		want string
	}{
		{Flatpak{}, "0.4.0", "stable:luna-desktop-x86_64.flatpak beta:luna-desktop-beta-x86_64.flatpak"},
		{Flatpak{SkipBeta: true}, "0.4.0", "stable:luna-desktop-x86_64.flatpak"},
		{Flatpak{}, "0.4.1-beta.2", "beta:luna-desktop-x86_64.flatpak"},
		{Flatpak{}, "0.4.1-0.dev.12", "beta:luna-desktop-x86_64.flatpak"},
		{Flatpak{Channel: "beta"}, "0.4.0", "beta:luna-desktop-x86_64.flatpak"},
	}
	for _, c := range cases {
		bs, err := c.f.Bundles(c.ver)
		if err != nil {
			t.Fatal(err)
		}
		var got []string
		for _, b := range bs {
			got = append(got, b.Branch+":"+b.File)
		}
		if strings.Join(got, " ") != c.want {
			t.Errorf("%+v %s: got %v, want %s", c.f, c.ver, got, c.want)
		}
	}
	if _, err := (&Flatpak{Channel: "nightly"}).Bundles("0.4.0"); err == nil {
		t.Error("bad channel accepted")
	}
}

func TestDesktopGraphAndSpecs(t *testing.T) {
	b := lunaCtx(t, "luna-desktop", "0.4.0")
	m := jobIDs(t, b, &Flatpak{}, &WindowsInstaller{})
	if len(m) != 2 || m["luna-desktop/flatpak"] != nil && len(m["luna-desktop/flatpak"]) != 0 {
		t.Fatalf("jobs %v", m)
	}
	if _, ok := m["luna-desktop/windows"]; !ok {
		t.Fatalf("jobs %v", m)
	}
	if WindowsFile != "Luna-Desktop-Setup-x86_64.exe" {
		t.Fatal(WindowsFile)
	}
	img := engine.Image{Name: "flatpak-builder", Hash: "h", RunOpts: []string{"--security-opt", "seccomp=unconfined"}}
	fs, err := (&Flatpak{}).spec(b)
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Join(b.Engine.RunArgs(img, fs, "n"), " ")
	for _, w := range []string{"flatpak-user:/root/.local/share/flatpak", "flatpak-builder:/root/.local/share/flatpak-builder", "/src/luna/desktop/VERSION:ro", "--memory 8g", "seccomp=unconfined"} {
		if !strings.Contains(args, w) {
			t.Errorf("flatpak args lack %q:\n%s", w, args)
		}
	}
	if strings.Contains(args, "--repo-url") || strings.Contains(args, "gpg-keys") {
		t.Error("bundle must carry no repo URL or keys")
	}
	ws, err := (&WindowsInstaller{}).spec(b)
	if err != nil {
		t.Fatal(err)
	}
	if ws.Env["LUNA_DESKTOP_VERSION"] != "0.4.0" || ws.Env["INSTALLER"] != WindowsFile {
		t.Errorf("env %v", ws.Env)
	}
	if !strings.Contains(strings.Join(b.Engine.RunArgs(img, ws, "n"), " "), ":/msys2") {
		t.Error("no msys2 volume")
	}
}

func TestIntegrationFlatpak(t *testing.T) {
	slowOrSkip(t)
	b := lunaRealCtx(t, "luna-desktop", "0.4.1-0.dev.12")
	d := runGraph(t, b, &Flatpak{})
	t.Logf("flatpak: %s", d.Round(time.Second))
	if _, err := os.Stat(filepath.Join(b.PartOutDir("flatpak"), FlatpakFile)); err != nil {
		t.Fatal(err)
	}
}

func TestIntegrationWindows(t *testing.T) {
	slowOrSkip(t)
	b := lunaRealCtx(t, "luna-desktop", "0.4.1-0.dev.12")
	d := runGraph(t, b, &WindowsInstaller{})
	t.Logf("windows: %s", d.Round(time.Second))
	if _, err := os.Stat(filepath.Join(b.PartOutDir("windows"), WindowsFile)); err != nil {
		t.Fatal(err)
	}
}
