package main

import (
	"errors"
	"flag"
	"fmt"
	"os"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
)

type cutJSON struct {
	OK        bool                 `json:"ok"`
	Error     string               `json:"error,omitempty"`
	Preflight *app.PreflightReport `json:"preflight,omitempty"`
	Result    *app.CutResult       `json:"result,omitempty"`
}

func cmdCut(args []string) int {
	fs := flag.NewFlagSet("cut", flag.ContinueOnError)
	channel := fs.String("channel", "", "stable or beta (required)")
	bump := fs.String("bump", "", "patch, minor, major or beta (default: beta on the beta channel, else patch)")
	ver := fs.String("version", "", "explicit version instead of --bump")
	resume := fs.Bool("resume", false, "continue an unfinished cut of this unit")
	dry := fs.Bool("dry-run", false, "do everything locally; push and upload nothing")
	notes := fs.String("notes", "", "release notes text (default: draft from commit subjects)")
	notesFile := fs.String("notes-file", "", "read the release notes from a file")
	jobs := fs.Int("jobs", 0, "parallel jobs (default: CPU count)")
	heavy := fs.Int("heavy-jobs", 2, "parallel memory-heavy jobs")
	asJSON := fs.Bool("json", false, "print the result as JSON on stdout (progress stays on stderr)")
	quiet := fs.Bool("quiet", false, "no progress lines")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: release cut <unit> --channel beta|stable [--bump patch|minor|major|beta | --version V] [--resume] [--dry-run]")
		fmt.Fprintln(os.Stderr, "Order: preflight, bump commit pushed to origin, build that SHA, sign, upload, verify, feed commit, wait for the mirror, tag.")
		fs.PrintDefaults()
	}
	pos, err := parseInterspersed(fs, args)
	if err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		return 2
	}
	if len(pos) != 1 || *channel == "" {
		fs.Usage()
		return 2
	}
	text := *notes
	if *notesFile != "" {
		b, err := os.ReadFile(*notesFile)
		if err != nil {
			return fail("cut", err)
		}
		text = string(b)
	}
	ev := eventPrinter(os.Stderr)
	if *quiet {
		ev = nil
	}
	a, err := newApp(appOpts{events: ev, prompt: !*asJSON, keyring: true})
	if err != nil {
		return fail("cut", err)
	}
	ctx, stop := signalContext()
	defer stop()
	res, err := a.Cut(ctx, app.CutRequest{Unit: pos[0], Channel: *channel, Bump: *bump, Version: *ver,
		Notes: text, Resume: *resume, Dry: *dry, Jobs: *jobs, HeavyJobs: *heavy})

	var pe *app.PreflightError
	isPre := errors.As(err, &pe)
	if *asJSON {
		j := cutJSON{OK: err == nil, Result: res}
		if err != nil {
			j.Error = a.Redact(err.Error())
		}
		if isPre {
			j.Preflight = pe.Report
		}
		printJSON(j)
		if err != nil {
			return 1
		}
		return 0
	}
	if isPre {
		printPreflight(pe.Report)
		return 1
	}
	if err != nil {
		return fail("cut", fmt.Errorf("%s (fix it and run again with --resume)", a.Redact(err.Error())))
	}
	printCut(res)
	return 0
}

func printPreflight(r *app.PreflightReport) {
	fmt.Fprintf(os.Stderr, "Preflight for %s (%s) failed:\n", r.Unit, r.Channel)
	for _, c := range r.Checks {
		fmt.Fprintf(os.Stderr, "  %-4s %-30s %s\n", c.State, c.Name, c.Detail)
	}
	for _, st := range r.Secrets {
		if st.State == "proven" {
			continue
		}
		fmt.Fprintf(os.Stderr, "\n%s: %s\n", st.Label, st.Summary)
		printCandidates(os.Stderr, st)
	}
	fmt.Fprintln(os.Stderr, "\nRun `release secrets prove` to unlock or add what is missing.")
}

func printCut(r *app.CutResult) {
	verb := "Cut"
	if r.Dry {
		verb = "Dry run of"
	}
	fmt.Printf("%s %s %s on %s\n", verb, r.Unit, r.Version, r.Channel)
	fmt.Printf("  commit  %s\n  tag     %s", r.SHA, r.Tag)
	if r.Dry {
		fmt.Printf("  (not pushed)")
	}
	fmt.Println()
	if r.FeedSHA != "" {
		fmt.Printf("  feeds   commit %.12s\n", r.FeedSHA)
	}
	for _, u := range r.FeedURLs {
		fmt.Printf("    %s\n", u)
	}
	fmt.Printf("  files (%s)\n", strings.TrimSpace(r.OutDir))
	for _, u := range r.Files {
		fmt.Printf("    %s\n", u)
	}
	if r.Dry {
		fmt.Printf("  dry-run feeds are in %s/dry-feeds\n", r.OutDir)
	}
}
