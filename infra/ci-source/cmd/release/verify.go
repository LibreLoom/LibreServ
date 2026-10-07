package main

import (
	"flag"
	"fmt"
	"os"
	"time"
)

func cmdVerify(args []string) int {
	fs := flag.NewFlagSet("verify", flag.ContinueOnError)
	channel := fs.String("channel", "", "stable or beta (default: both)")
	asJSON := fs.Bool("json", false, "print the result as JSON")
	fs.Usage = func() {
		fmt.Fprintln(os.Stderr, "Usage: release verify <unit> [channel] [--channel C] [--json]")
		fmt.Fprintln(os.Stderr, "Fetches the live feed, checks its signature against keys/, then downloads every URL and checks size and sha256.")
		fs.PrintDefaults()
	}
	pos, err := parseInterspersed(fs, args)
	if err != nil {
		if err == flag.ErrHelp {
			return 0
		}
		return 2
	}
	if len(pos) < 1 || len(pos) > 2 {
		fs.Usage()
		return 2
	}
	ch := *channel
	if len(pos) == 2 {
		ch = pos[1]
	}
	a, err := newApp(appOpts{})
	if err != nil {
		return fail("verify", err)
	}
	ctx, stop := signalContext()
	defer stop()
	start := time.Now()
	vs, err := a.Verify(ctx, pos[0], ch)
	if err != nil {
		return fail("verify", err)
	}
	code := 0
	for _, v := range vs {
		if !v.OK() {
			code = 1
		}
	}
	if *asJSON {
		printJSON(map[string]any{"ok": code == 0, "feeds": vs})
		return code
	}
	for _, v := range vs {
		if v.OK() {
			fmt.Printf("ok    %s %s: version %s, %d parts verified\n", v.Unit, v.Channel, v.Feed.Version, len(v.Feed.Parts))
		} else {
			fmt.Printf("FAIL  %s %s (%s)\n      %v\n", v.Unit, v.Channel, v.URL, v.Err)
		}
	}
	fmt.Printf("checked in %s\n", time.Since(start).Round(100*time.Millisecond))
	return code
}
