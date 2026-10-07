// Command release is the LibreServ release tool. Build steps run in rootless
// podman containers; podman is the only host dependency.
package main

import (
	"fmt"
	"os"
)

const usage = `LibreServ release tool

Usage:
  release <command> [flags]

Commands:
  build <unit>[:<part>...]   Build parts into dist/ (no secrets, never publishes)
  cut <unit> <version|kind>  Build, sign and publish a release
  verify <unit> <channel>    Check a published feed: signature, URLs, sizes, hashes
  serve-dev                  Serve dist/ with a test-key feed over http
  secrets                    Manage release secrets
  doctor                     Check podman, storage, caches and images
  images [flags]             Show and build toolchain images
  help                       Show this help

With no command the interactive TUI starts (not implemented yet).
Run "release <command> -h" for a command's flags.
`

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "release: the interactive TUI is not implemented yet")
		fmt.Fprint(os.Stderr, "\n"+usage)
		os.Exit(2)
	}
	cmd, args := os.Args[1], os.Args[2:]
	var code int
	switch cmd {
	case "images":
		code = cmdImages(args)
	case "doctor":
		code = cmdDoctor(args)
	case "build":
		code = cmdBuild(args)
	case "cut", "verify", "serve-dev", "secrets":
		fmt.Fprintf(os.Stderr, "release %s: not implemented yet\n", cmd)
		code = 2
	case "help", "-h", "--help":
		fmt.Print(usage)
	default:
		fmt.Fprintf(os.Stderr, "release: unknown command %q\n\n%s", cmd, usage)
		code = 2
	}
	os.Exit(code)
}
