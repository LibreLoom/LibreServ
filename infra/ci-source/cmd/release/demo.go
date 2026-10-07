package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/parts"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/version"
)

// The demo unit exercises the whole build path (export, graph, output dir,
// signed sums) without any toolchain: `release build demo`. With
// RELEASE_DEMO_CONTAINER=1 it also runs a job in a toolchain container.
const demoUnit = "demo"

var demoOnce sync.Once

func registerDemo() {
	demoOnce.Do(func() { parts.Register(demoUnit, demoPart{"hello"}, demoPart{"entries"}) })
}

type demoPart struct{ name string }

func (p demoPart) Name() string { return p.name }
func (demoPart) Unit() string   { return demoUnit }

func (p demoPart) Jobs(b *engine.BuildContext) ([]engine.Job, error) {
	id := demoUnit + "/" + p.name
	out := b.PartOutDir(p.name)
	switch p.name {
	case "hello":
		return []engine.Job{{ID: id, Title: "Write a greeting", Run: func(ctx context.Context, j *engine.JobRun) error {
			j.Logf("building %s %s from %s", b.Unit, b.Version, b.Commit[:12])
			return os.WriteFile(filepath.Join(out, "demo-hello.txt"), []byte("hello from "+b.Version+"\n"), 0o644)
		}}}, nil
	default:
		jobs := []engine.Job{{ID: id, Title: "Count top-level entries", Deps: []string{demoUnit + "/hello"}, Run: func(ctx context.Context, j *engine.JobRun) error {
			ents, err := os.ReadDir(b.SrcDir)
			if err != nil {
				return err
			}
			j.Logf("source has %d top-level entries", len(ents))
			return os.WriteFile(filepath.Join(out, "demo-entries.txt"), []byte(fmt.Sprintln(len(ents))), 0o644)
		}}}
		if os.Getenv("RELEASE_DEMO_CONTAINER") == "1" {
			jobs = append(jobs, engine.Job{ID: id + ":container", Title: "Run in a container", Run: func(ctx context.Context, j *engine.JobRun) error {
				return j.Container(ctx, engine.RunSpec{Image: "alpine-os", Source: b.SrcDir, Out: out, Memory: "256m",
					Cmd: []string{"sh", "-c", "ls | head -n 3; ls | wc -l > /out/demo-container.txt"}})
			}})
		}
		return jobs, nil
	}
}

// devVersion is version.DevVersion, plus a fixed version for the demo unit
// (it has no VERSION file or tags).
func devVersion(ctx context.Context, repo, unit, ref string) (version.Version, error) {
	if unit == demoUnit {
		return version.Dev(version.Version{}, 0), nil
	}
	return version.DevVersion(ctx, repo, unit, ref)
}

// feedSpecs is the parts table; the demo unit has none (every file counts).
func feedSpecs(unit string) []app.FileSpec {
	if unit == demoUnit {
		return nil
	}
	return app.DefaultFileSpecs(unit)
}
