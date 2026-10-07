package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

func cmdBuild(args []string) int {
	fs := flag.NewFlagSet("build", flag.ExitOnError)
	head := fs.Bool("head", false, "build the checked-out HEAD (default)")
	ref := fs.String("ref", "", "build this git ref instead of HEAD")
	ver := fs.String("version", "", "version to stamp (default: dev version)")
	jobs := fs.Int("jobs", runtime.NumCPU(), "parallel jobs")
	heavy := fs.Int("heavy-jobs", 2, "parallel memory-heavy jobs")
	noFailFast := fs.Bool("no-fail-fast", false, "keep running independent jobs after a failure")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: release build [<unit>[:<part>...]] [--head | --ref R] [--version V] [--jobs N]")
		fmt.Fprintln(os.Stderr, "With no unit, runs a demo job graph to exercise the engine.")
		fs.PrintDefaults()
	}
	fs.Parse(args)
	_ = *head
	_ = *ver

	if fs.NArg() > 0 {
		fmt.Fprintf(os.Stderr, "release build %s: no parts are registered yet (only the demo graph exists)\n", strings.Join(fs.Args(), " "))
		return 2
	}
	e, err := newEngine()
	if err != nil {
		fmt.Fprintln(os.Stderr, "release build:", err)
		return 1
	}
	ctx, stop := signalContext()
	defer stop()

	r := *ref
	if r == "" {
		r = "HEAD"
	}
	g, err := demoGraph(e, r)
	if err != nil {
		fmt.Fprintln(os.Stderr, "release build:", err)
		return 1
	}
	res, err := g.Run(ctx, engine.Options{
		Jobs:      *jobs,
		HeavyJobs: *heavy,
		FailFast:  !*noFailFast,
		Engine:    e,
		Redactor:  e.Redactor,
		OnEvent:   printEvent,
	})
	if err != nil {
		fmt.Fprintln(os.Stderr, "release build:", err)
		return 1
	}
	fmt.Printf("\n%-22s %-10s %s\n", "job", "status", "time")
	for _, j := range res.Jobs {
		fmt.Printf("%-22s %-10s %s\n", j.ID, j.Status, j.Duration.Round(10*time.Millisecond))
	}
	fmt.Printf("total %s\n", res.Duration.Round(10*time.Millisecond))
	if !res.OK() {
		fmt.Fprintln(os.Stderr, "release build:", res.FirstError())
		return 1
	}
	return 0
}

func printEvent(ev engine.Event) {
	switch ev.Type {
	case engine.EventStarted:
		fmt.Printf("[%s] started\n", ev.Job)
	case engine.EventLog:
		fmt.Printf("[%s] %s\n", ev.Job, ev.Line)
	case engine.EventFinished:
		if ev.Err != nil {
			fmt.Printf("[%s] %s: %v\n", ev.Job, ev.Status, ev.Err)
		} else {
			fmt.Printf("[%s] %s in %s\n", ev.Job, ev.Status, ev.Elapsed.Round(10*time.Millisecond))
		}
	}
}

// demoGraph exports the ref, then fans out into container jobs that join in
// a final check. It exists to exercise the engine end to end.
func demoGraph(e *engine.Engine, ref string) (*engine.Graph, error) {
	var src, sha string
	out := filepath.Join(e.CacheDir(), "demo-out")
	g := engine.NewGraph()
	err := g.Add(
		engine.Job{ID: "demo/export", Title: "Export source", Run: func(ctx context.Context, j *engine.JobRun) error {
			var err error
			src, sha, err = e.Export(ctx, ref)
			if err != nil {
				return err
			}
			j.Logf("exported %s to %s", sha[:12], src)
			return os.MkdirAll(out, 0o755)
		}},
		engine.Job{ID: "demo/go-version", Deps: []string{"demo/export"}, Run: func(ctx context.Context, j *engine.JobRun) error {
			return j.Container(ctx, engine.RunSpec{Image: "go", Source: src, Caches: engine.GoCaches(), Memory: "1g",
				Cmd: []string{"go", "version"}})
		}},
		engine.Job{ID: "demo/list-source", Deps: []string{"demo/export"}, Run: func(ctx context.Context, j *engine.JobRun) error {
			return j.Container(ctx, engine.RunSpec{Image: "alpine-os", Source: src, Out: out, Memory: "256m",
				Cmd: []string{"sh", "-c", "ls | head -n 5; ls | wc -l > /out/source-entries.txt"}})
		}},
		engine.Job{ID: "demo/heavy", Heavy: true, Deps: []string{"demo/export"}, Run: func(ctx context.Context, j *engine.JobRun) error {
			return j.Container(ctx, engine.RunSpec{Image: "alpine-os", Source: src, Memory: "512m",
				Cmd: []string{"sh", "-c", "echo pretending to link; sleep 2"}})
		}},
		engine.Job{ID: "demo/check", Deps: []string{"demo/go-version", "demo/list-source", "demo/heavy"}, Run: func(ctx context.Context, j *engine.JobRun) error {
			b, err := os.ReadFile(filepath.Join(out, "source-entries.txt"))
			if err != nil {
				return err
			}
			j.Logf("source has %s top-level entries", strings.TrimSpace(string(b)))
			return nil
		}},
	)
	return g, err
}
