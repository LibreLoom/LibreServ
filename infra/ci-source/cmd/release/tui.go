package main

import (
	"fmt"
	"os"

	"golang.org/x/term"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/tui"
)

// cmdTUI opens the interactive TUI. Without a terminal it prints the usage.
func cmdTUI() int {
	if !term.IsTerminal(int(os.Stdin.Fd())) || !term.IsTerminal(int(os.Stdout.Fd())) {
		fmt.Fprintln(os.Stderr, "release: the interactive TUI needs a terminal; pass a command instead")
		fmt.Fprint(os.Stderr, "\n"+usage)
		return 2
	}
	br := tui.NewBridge()
	a, err := newApp(appOpts{keyring: true, events: br.OnEvent, prompter: br})
	if err != nil {
		return fail("tui", err)
	}
	if err := tui.Run(tui.FromApp(a), br); err != nil {
		return fail("tui", err)
	}
	return 0
}
