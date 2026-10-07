package main

import (
	"flag"
	"fmt"
	"os"
	"runtime"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
)

type buildJSON struct {
	OK       bool            `json:"ok"`
	Error    string          `json:"error,omitempty"`
	Commit   string          `json:"commit,omitempty"`
	DevKeyID string          `json:"dev_key_id,omitempty"`
	Units    []app.UnitBuild `json:"units"`
	Jobs     []jobJSON       `json:"jobs"`
	Seconds  float64         `json:"seconds"`
}

type jobJSON struct {
	ID      string  `json:"id"`
	Status  string  `json:"status"`
	Error   string  `json:"error,omitempty"`
	Seconds float64 `json:"seconds"`
}

func cmdBuild(args []string) int {
	fs := flag.NewFlagSet("build", flag.ContinueOnError)
	ref := fs.String("ref", "", "git ref to build (default HEAD)")
	head := fs.Bool("head", false, "build the checked-out HEAD (the default)")
	partsF := fs.String("parts", "", "comma-separated parts to build (and what they need)")
	ver := fs.String("version", "", "version to stamp (default: dev version)")
	jobs := fs.Int("jobs", runtime.NumCPU(), "parallel jobs")
	heavy := fs.Int("heavy-jobs", 2, "parallel memory-heavy jobs")
	out := fs.String("out", "", "output root (default <repo>/dist)")
	noFailFast := fs.Bool("no-fail-fast", false, "keep running independent jobs after a failure")
	asJSON := fs.Bool("json", false, "print the result as JSON on stdout (progress stays on stderr)")
	quiet := fs.Bool("quiet", false, "no progress lines")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: release build <unit|all>[:<part>,...] [--ref R] [--parts a,b] [--version V] [--jobs N] [--out dist] [--json]")
		fmt.Fprintln(os.Stderr, "Builds from a git export of the ref (never your working tree) into <out>/<unit>/<version>/")
		fmt.Fprintln(os.Stderr, "and signs SHA256SUMS.txt with a local TEST key. Try: release build demo")
		fs.PrintDefaults()
	}
	pos, err := parseInterspersed(fs, args)
	if err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		return 2
	}
	if len(pos) != 1 {
		fs.Usage()
		return 2
	}
	_ = *head
	unit, partSel, _ := strings.Cut(pos[0], ":")
	var names []string
	for _, p := range strings.Split(partSel+","+*partsF, ",") {
		if p = strings.TrimSpace(p); p != "" {
			names = append(names, p)
		}
	}

	ev := eventPrinter(os.Stderr)
	if *quiet {
		ev = nil
	}
	a, err := newApp(appOpts{events: ev, outRoot: absOut(*out)})
	if err != nil {
		return fail("build", err)
	}
	ctx, stop := signalContext()
	defer stop()
	res, err := a.Build(ctx, app.BuildRequest{Unit: unit, Ref: *ref, Parts: names, Version: *ver,
		Jobs: *jobs, HeavyJobs: *heavy, NoFailFast: *noFailFast})

	if *asJSON {
		j := buildJSON{OK: err == nil, Units: []app.UnitBuild{}, Jobs: []jobJSON{}}
		if err != nil {
			j.Error = a.Redact(err.Error())
		}
		if res != nil {
			j.Commit, j.DevKeyID, j.Seconds = res.Commit, res.DevKeyID, res.Duration.Seconds()
			j.Units = append(j.Units, res.Units...)
			for _, r := range res.Jobs {
				jj := jobJSON{ID: r.ID, Status: r.Status.String(), Seconds: r.Duration.Seconds()}
				if r.Err != nil {
					jj.Error = a.Redact(r.Err.Error())
				}
				j.Jobs = append(j.Jobs, jj)
			}
		}
		printJSON(j)
		if err != nil {
			return 1
		}
		return 0
	}
	if res != nil {
		printBuild(res)
	}
	if err != nil {
		return fail("build", fmt.Errorf("%s", a.Redact(err.Error())))
	}
	return 0
}

func absOut(p string) string {
	if p == "" {
		return ""
	}
	if r, err := repoRoot(); err == nil && !strings.HasPrefix(p, "/") {
		return r + "/" + p
	}
	return p
}

func printBuild(res *app.BuildResult) {
	if len(res.Jobs) > 0 {
		fmt.Printf("%-30s %-10s %s\n", "job", "status", "time")
		for _, j := range res.Jobs {
			fmt.Printf("%-30s %-10s %s\n", j.ID, j.Status, j.Duration.Round(10*time.Millisecond))
		}
		fmt.Printf("total %s\n", res.Duration.Round(10*time.Millisecond))
	}
	for _, u := range res.Units {
		fmt.Printf("\n%s %s  (commit %.12s)\n  %s\n", u.Unit, u.Version, res.Commit, u.Dir)
		for _, f := range u.Files {
			fmt.Printf("  %-44s %10s  %.16s\n", f.Name, humanSize(f.Size), f.SHA256)
		}
		if len(u.Missing) > 0 {
			fmt.Printf("  not produced: %s\n", strings.Join(u.Missing, ", "))
		}
	}
	if res.DevKeyID != "" {
		fmt.Printf("\nSHA256SUMS.txt is signed with the local TEST key %s (never trusted by production).\n", res.DevKeyID)
	}
}
