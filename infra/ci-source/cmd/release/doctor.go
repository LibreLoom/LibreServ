package main

import (
	"flag"
	"fmt"
	"os"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
)

func cmdDoctor(args []string) int {
	fs := flag.NewFlagSet("doctor", flag.ExitOnError)
	asJSON := fs.Bool("json", false, "print the report as JSON")
	fs.Parse(args)
	ctx, stop := signalContext()
	defer stop()

	a, err := newApp(appOpts{keyring: true})
	if err != nil {
		fmt.Fprintln(os.Stderr, "release doctor:", err)
		return 1
	}
	r := a.Doctor(ctx, true)
	if *asJSON {
		printJSON(r)
		if r.Failed() {
			return 1
		}
		return 0
	}
	printDoctor(r)
	switch {
	case !r.PodmanOK:
		fmt.Println("\nPodman is required; fix it and run doctor again.")
		return 1
	case r.Failed():
		fmt.Println("\nProblems found.")
		return 1
	case r.Warned():
		fmt.Println("\nOK, with warnings.")
	default:
		fmt.Println("\nAll good.")
	}
	return 0
}

func printDoctor(r *app.DoctorReport) {
	for _, sec := range r.Sections {
		fmt.Println(sec.Title)
		for _, c := range sec.Checks {
			mark := map[string]string{app.CheckOK: "ok  ", app.CheckWarn: "warn", app.CheckFail: "FAIL"}[c.State]
			fmt.Printf("  %-5s %-18s %s\n", mark, c.Name, c.Detail)
		}
	}
}
