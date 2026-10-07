// Command release is the LibreServ release tool. Build steps run in rootless
// podman containers; podman is the only host dependency.
package main

import (
	"fmt"
	"os"
	"strings"
)

const usage = `LibreServ release tool

Usage:
  release [--repo DIR] <command> [flags]

Commands:
  build <unit|all>           Build into dist/ (no release secrets, never publishes)
  cut <unit>                 Build, sign and publish a release
  verify <unit> [channel]    Check a published feed: signature, URLs, sizes, hashes
  serve-dev                  Serve dist/ with a test-key feed over http
  secrets [subcommand]       Find, prove and manage release secrets
  doctor                     Check podman, storage, caches, images and secrets
  images [flags]             Show and build toolchain images
  help                       Show this help

Units: sol, sol-connect, luna, luna-desktop, luna-android, luna-connect
Global: --repo DIR  the LibreServ checkout (default: detected from the
        current directory, or $LIBRESERV_REPO)
Run "release <command> -h" for a command's flags.
With no command the interactive TUI starts (on a terminal).
`

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	for len(args) > 0 && (args[0] == "--repo" || strings.HasPrefix(args[0], "--repo=")) {
		if v, ok := strings.CutPrefix(args[0], "--repo="); ok {
			repoFlag = v
			args = args[1:]
			continue
		}
		if len(args) < 2 {
			fmt.Fprintln(os.Stderr, "release: --repo needs a directory")
			return 2
		}
		repoFlag, args = args[1], args[2:]
	}
	if len(args) < 1 {
		return cmdTUI()
	}
	cmd, rest := args[0], args[1:]
	switch cmd {
	case "images":
		return cmdImages(rest)
	case "doctor":
		return cmdDoctor(rest)
	case "build":
		return cmdBuild(rest)
	case "cut":
		return cmdCut(rest)
	case "verify":
		return cmdVerify(rest)
	case "serve-dev":
		return cmdServeDev(rest)
	case "secrets":
		return cmdSecrets(rest)
	case "help", "-h", "--help":
		fmt.Print(usage)
		return 0
	}
	fmt.Fprintf(os.Stderr, "release: unknown command %q\n\n%s", cmd, usage)
	return 2
}
