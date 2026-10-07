package parts

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/version"
)

// Exported so the CLI can set options before building the graph.
var (
	// DesktopFlatpak is luna-desktop/flatpak.
	DesktopFlatpak = &Flatpak{}
	// DesktopWindows is luna-desktop/windows.
	DesktopWindows = &WindowsInstaller{}
)

func init() {
	Register("luna-desktop", DesktopFlatpak, DesktopWindows)
}

// File names, exactly as in the plan's parts table.
const (
	FlatpakFile     = "luna-desktop-x86_64.flatpak"
	FlatpakBetaFile = "luna-desktop-beta-x86_64.flatpak"
	WindowsFile     = "Luna-Desktop-Setup-x86_64.exe"
	FlatpakJob      = "luna-desktop/flatpak"
	WindowsJob      = "luna-desktop/windows"
)

// Flatpak builds the Linux bundle(s), the input of the Flatpak repo server:
// branch = channel, no repo URL and no GPG keys (a bundle that names a key but
// has no signature will not install).
//
// By default the channel follows the version: X.Y.Z is "stable", anything with
// a pre-release (X.Y.Z-beta.N, dev builds) is "beta". The bundle for the
// channel is luna-desktop-x86_64.flatpak. A stable release also builds
// luna-desktop-beta-x86_64.flatpak (branch beta), because a stable release
// that is newer than beta's current version updates the beta feed too.
type Flatpak struct {
	// Channel forces "stable" or "beta" instead of deriving it from the version.
	Channel string
	// SkipBeta leaves out the extra beta bundle of a stable release (the
	// caller found beta's feed is already newer).
	SkipBeta bool
}

func (*Flatpak) Name() string { return "flatpak" }
func (*Flatpak) Unit() string { return "luna-desktop" }

// FlatpakBundle is one bundle: ref branch and file name.
type FlatpakBundle struct{ Branch, File string }

// Bundles lists the bundles this build produces for ver.
func (f *Flatpak) Bundles(ver string) ([]FlatpakBundle, error) {
	ch := f.Channel
	if ch == "" {
		v, err := version.Parse(ver)
		if err != nil {
			return nil, err
		}
		ch = "stable"
		if v.IsPrerelease() {
			ch = "beta"
		}
	}
	switch ch {
	case "stable":
		out := []FlatpakBundle{{"stable", FlatpakFile}}
		if !f.SkipBeta {
			out = append(out, FlatpakBundle{"beta", FlatpakBetaFile})
		}
		return out, nil
	case "beta":
		return []FlatpakBundle{{"beta", FlatpakFile}}, nil
	}
	return nil, fmt.Errorf("flatpak channel %q: want stable or beta", ch)
}

// Files lists the file names the part writes for ver.
func (f *Flatpak) Files(ver string) ([]string, error) {
	bs, err := f.Bundles(ver)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, b := range bs {
		names = append(names, b.File)
	}
	return names, nil
}

func (f *Flatpak) Jobs(b *engine.BuildContext) ([]engine.Job, error) {
	if _, err := f.Bundles(b.Version); err != nil {
		return nil, err
	}
	return []engine.Job{{ID: FlatpakJob, Title: "Luna Desktop Flatpak", Heavy: true,
		Run: func(ctx context.Context, j *engine.JobRun) error {
			spec, err := f.spec(b)
			if err != nil {
				return err
			}
			return j.Container(ctx, spec)
		}}}, nil
}

func (f *Flatpak) spec(b *engine.BuildContext) (engine.RunSpec, error) {
	bs, err := f.Bundles(b.Version)
	if err != nil {
		return engine.RunSpec{}, err
	}
	out := b.PartOutDir("flatpak")
	if err := os.MkdirAll(out, 0o755); err != nil {
		return engine.RunSpec{}, err
	}
	ver, err := lunaVersionMount(b, "luna/desktop/VERSION")
	if err != nil {
		return engine.RunSpec{}, err
	}
	var list []string
	for _, bd := range bs {
		list = append(list, bd.Branch+":"+bd.File)
	}
	return lunaShell(engine.RunSpec{
		Name:    "flatpak",
		Image:   "flatpak-builder",
		Out:     out,
		Mounts:  []engine.Mount{lunaSrcMount(b), ver},
		Caches: []engine.Cache{engine.CacheFlatpak,
			{Volume: "flatpak-user", Target: "/root/.local/share/flatpak"}},
		Env:    map[string]string{"BRANCHES": strings.Join(list, " ")},
		Memory: "8g",
	}, "bash", "flatpak.sh"), nil
}

// WindowsInstaller cross-builds the Windows installer (MinGW + NSIS).
type WindowsInstaller struct{}

func (*WindowsInstaller) Name() string { return "windows" }
func (*WindowsInstaller) Unit() string { return "luna-desktop" }

func (w *WindowsInstaller) Jobs(b *engine.BuildContext) ([]engine.Job, error) {
	return []engine.Job{{ID: WindowsJob, Title: "Luna Desktop Windows installer", Heavy: true,
		Run: func(ctx context.Context, j *engine.JobRun) error {
			spec, err := w.spec(b)
			if err != nil {
				return err
			}
			return j.Container(ctx, spec)
		}}}, nil
}

func (*WindowsInstaller) spec(b *engine.BuildContext) (engine.RunSpec, error) {
	out := b.PartOutDir("windows")
	if err := os.MkdirAll(out, 0o755); err != nil {
		return engine.RunSpec{}, err
	}
	if err := lunaMountPoints(b, "luna/desktop/target"); err != nil {
		return engine.RunSpec{}, err
	}
	ver, err := lunaVersionMount(b, "luna/desktop/VERSION")
	if err != nil {
		return engine.RunSpec{}, err
	}
	// The sysroot is unpacked once per package list: a changed manifest gets a
	// fresh volume instead of a stale tree.
	man, err := os.ReadFile(filepath.Join(b.SrcDir, "luna/desktop/packaging/windows/msys2-manifest.txt"))
	if err != nil {
		return engine.RunSpec{}, err
	}
	h := sha256.Sum256(man)
	return lunaShell(engine.RunSpec{
		Name:    "windows",
		Image:   "mingw-nsis",
		Workdir: "/src/luna/desktop",
		Out:     out,
		Mounts:  []engine.Mount{lunaSrcMount(b), ver},
		Caches: []engine.Cache{engine.CacheCargoRegistry, engine.CacheCargoGit,
			{Volume: "target-desktop-windows", Target: "/src/luna/desktop/target"},
			{Volume: "msys2-" + hex.EncodeToString(h[:])[:12], Target: "/msys2"}},
		Env: map[string]string{
			"LUNA_DESKTOP_VERSION": b.Version,
			"INSTALLER":            WindowsFile,
		},
		Memory: "6g",
	}, "bash", "windows.sh"), nil
}
