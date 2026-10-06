// Command feedgen writes the signed test feeds into infra/feed-testdata/.
// Output is deterministic: re-running changes nothing.
package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/feedfixtures"
)

func main() {
	out := flag.String("out", "", "output directory (default: infra/feed-testdata under the repo root)")
	flag.Parse()
	dir := *out
	if dir == "" {
		root, err := repoRoot()
		if err != nil {
			fmt.Fprintln(os.Stderr, "feedgen:", err)
			os.Exit(1)
		}
		dir = filepath.Join(root, "infra", "feed-testdata")
	}
	if err := feedfixtures.Generate(dir); err != nil {
		fmt.Fprintln(os.Stderr, "feedgen:", err)
		os.Exit(1)
	}
	fmt.Println("wrote", dir)
}

// repoRoot walks up from the working directory to the checkout root
// (the directory holding sol/ and luna/).
func repoRoot() (string, error) {
	d, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(d, "sol", "server")); err == nil {
			if _, err := os.Stat(filepath.Join(d, "infra")); err == nil {
				return d, nil
			}
		}
		p := filepath.Dir(d)
		if p == d {
			return "", fmt.Errorf("repo root not found; pass -out")
		}
		d = p
	}
}
