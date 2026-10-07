package parts

import (
	"context"
	"embed"
	"os"
	"path/filepath"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

func init() {
	Register("luna", &Lunad{})
}

// File names, exactly as in the plan's parts table.
const (
	LunadFile       = "lunad-linux-amd64-musl"
	LunadJob        = "luna/lunad"
	lunaWebJob      = "luna/lunad:web"
	lunaBuildJob    = "luna/lunad:build"
	lunaSmokeJob    = "luna/lunad:smoke"
	lunaConsoleName = "luna-console"
	muslTarget      = "x86_64-unknown-linux-musl"
)

//go:embed scripts/*.sh
var lunaScripts embed.FS

// lunaScript returns an embedded in-container script.
func lunaScript(name string) string {
	b, err := lunaScripts.ReadFile("scripts/" + name)
	if err != nil {
		panic(err) // a missing embedded file is a programming error
	}
	return string(b)
}

// lunaWorkDir is a scratch dir for a build's intermediates (web bundle, VERSION
// files, keystore copies). It sits beside the unit dirs, never inside a part's
// output dir, so nothing in it can be mistaken for a release file.
func lunaWorkDir(b *engine.BuildContext, name string) (string, error) {
	d := filepath.Join(b.OutRoot, ".work", b.Unit, b.Version, name)
	return d, os.MkdirAll(d, 0o755)
}

// LunaConsolePath is where the lunad build leaves luna-console (built with
// lunad, needed by the OS image), for parts that depend on LunadJob.
func LunaConsolePath(b *engine.BuildContext) string {
	return filepath.Join(b.OutRoot, ".work", b.Unit, b.Version, "extra", lunaConsoleName)
}

// lunaSrcMount mounts the exported tree read-only. Writes go only to the
// volumes and mounts layered over build dirs.
func lunaSrcMount(b *engine.BuildContext) engine.Mount {
	return engine.Mount{Host: b.SrcDir, Target: "/src", ReadOnly: true}
}

// lunaMountPoints creates empty dirs in the export for volumes to mount on
// (a read-only parent cannot take a mkdir from the container runtime).
func lunaMountPoints(b *engine.BuildContext, rels ...string) error {
	for _, r := range rels {
		if err := os.MkdirAll(filepath.Join(b.SrcDir, r), 0o755); err != nil {
			return err
		}
	}
	return nil
}

// lunaVersionMount mounts b.Version read-only over a VERSION file of the
// export, so toolchains that read it (build.rs, build-cross.sh) see the
// build's version, a dev version included, without editing the shared tree.
func lunaVersionMount(b *engine.BuildContext, rel string) (engine.Mount, error) {
	orig, err := os.Stat(filepath.Join(b.SrcDir, rel))
	if err != nil {
		return engine.Mount{}, err
	}
	dir, err := lunaWorkDir(b, "version")
	if err != nil {
		return engine.Mount{}, err
	}
	f := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(f), 0o755); err != nil {
		return engine.Mount{}, err
	}
	// Rewrite only on change, keeping the export's mtime: cargo compares
	// mtimes, so a touched VERSION would rebuild (and re-link) lunad.
	if old, err := os.ReadFile(f); err != nil || string(old) != b.Version+"\n" {
		if err := os.WriteFile(f, []byte(b.Version+"\n"), 0o644); err != nil {
			return engine.Mount{}, err
		}
	}
	if err := os.Chtimes(f, orig.ModTime(), orig.ModTime()); err != nil {
		return engine.Mount{}, err
	}
	return engine.Mount{Host: f, Target: "/src/" + rel, ReadOnly: true}, nil
}

// lunaShell runs an embedded script with the given shell ("sh" or "bash").
func lunaShell(spec engine.RunSpec, shell, script string) engine.RunSpec {
	if shell == "bash" {
		spec.Cmd = []string{"bash", "-euo", "pipefail", "-c", lunaScript(script), "script"}
	} else {
		spec.Cmd = []string{shell, "-eu", "-c", lunaScript(script), "script"}
	}
	return spec
}

// Lunad builds the Luna daemon: the web UI it embeds, then the static musl
// binary, then a smoke test in plain Alpine.
//
// Jobs: luna/lunad:web -> luna/lunad:build -> luna/lunad:smoke -> luna/lunad.
// Depend on "luna/lunad" to get a built and verified lunad.
type Lunad struct{}

func (*Lunad) Name() string { return "lunad" }
func (*Lunad) Unit() string { return "luna" }

func (*Lunad) Jobs(b *engine.BuildContext) ([]engine.Job, error) {
	return []engine.Job{
		{ID: lunaWebJob, Title: "Luna web UI", Heavy: true,
			Run: func(ctx context.Context, j *engine.JobRun) error {
				spec, err := lunaWebSpec(b)
				if err != nil {
					return err
				}
				return j.Container(ctx, spec)
			}},
		{ID: lunaBuildJob, Title: "lunad (musl)", Heavy: true, Deps: []string{lunaWebJob},
			Run: func(ctx context.Context, j *engine.JobRun) error {
				spec, err := lunadBuildSpec(b)
				if err != nil {
					return err
				}
				return j.Container(ctx, spec)
			}},
		{ID: lunaSmokeJob, Title: "lunad smoke test", Deps: []string{lunaBuildJob},
			Run: func(ctx context.Context, j *engine.JobRun) error {
				return j.Container(ctx, lunadSmokeSpec(b))
			}},
		{ID: LunadJob, Title: "lunad " + b.Version, Deps: []string{lunaSmokeJob},
			Run: func(ctx context.Context, j *engine.JobRun) error {
				p := filepath.Join(b.PartOutDir("lunad"), LunadFile)
				st, err := os.Stat(p)
				if err != nil {
					return err
				}
				j.Logf("%s (%d bytes)", p, st.Size())
				return nil
			}},
	}, nil
}

func lunaWebSpec(b *engine.BuildContext) (engine.RunSpec, error) {
	out, err := lunaWorkDir(b, "web-dist")
	if err != nil {
		return engine.RunSpec{}, err
	}
	if err := lunaMountPoints(b, "luna/web/node_modules", "shared/ui/node_modules"); err != nil {
		return engine.RunSpec{}, err
	}
	return lunaShell(engine.RunSpec{
		Name:    "luna-web",
		Image:   "node",
		Workdir: "/src",
		Mounts:  []engine.Mount{lunaSrcMount(b), {Host: out, Target: "/web-out"}},
		Caches: []engine.Cache{engine.CacheNpm,
			{Volume: "luna-web-node-modules", Target: "/src/luna/web/node_modules"},
			{Volume: "luna-shared-ui-node-modules", Target: "/src/shared/ui/node_modules"}},
		Env:    map[string]string{"NODE_OPTIONS": "--max-old-space-size=3072"},
		Memory: "4g",
	}, "bash", "luna-web.sh"), nil
}

func lunadBuildSpec(b *engine.BuildContext) (engine.RunSpec, error) {
	out := b.PartOutDir("lunad")
	extra := filepath.Dir(LunaConsolePath(b))
	for _, d := range []string{out, extra} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return engine.RunSpec{}, err
		}
	}
	web, err := lunaWorkDir(b, "web-dist")
	if err != nil {
		return engine.RunSpec{}, err
	}
	if err := lunaMountPoints(b, "luna/target", "luna/crates/lunad/web/dist"); err != nil {
		return engine.RunSpec{}, err
	}
	ver, err := lunaVersionMount(b, "luna/VERSION")
	if err != nil {
		return engine.RunSpec{}, err
	}
	return lunaShell(engine.RunSpec{
		Name:    "lunad",
		Image:   "rust-musl",
		Workdir: "/src/luna",
		Out:     out,
		Mounts: []engine.Mount{lunaSrcMount(b), ver,
			{Host: web, Target: "/src/luna/crates/lunad/web/dist", ReadOnly: true},
			{Host: extra, Target: "/extra"}},
		Caches: engine.CargoCaches("luna-musl", "/src/luna/target"),
		Memory: "6g",
	}, "bash", "lunad-build.sh"), nil
}

func lunadSmokeSpec(b *engine.BuildContext) engine.RunSpec {
	return lunaShell(engine.RunSpec{
		Name:  "lunad-smoke",
		Image: "alpine-smoke",
		Mounts: []engine.Mount{
			{Host: b.PartOutDir("lunad"), Target: "/w", ReadOnly: true},
			{Host: filepath.Dir(LunaConsolePath(b)), Target: "/x", ReadOnly: true}},
		Env:     map[string]string{"EXPECT_VERSION": b.Version},
		Network: "none",
		Memory:  "256m",
	}, "sh", "lunad-smoke.sh")
}
