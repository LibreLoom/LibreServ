package main

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

// repoRoot finds the checkout: $LIBRESERV_REPO, else git's top level of the
// working directory, else the first parent holding infra/release/images.
func repoRoot() (string, error) {
	if r := os.Getenv("LIBRESERV_REPO"); r != "" {
		return r, nil
	}
	var out bytes.Buffer
	cmd := exec.Command("git", "rev-parse", "--show-toplevel")
	cmd.Stdout = &out
	if err := cmd.Run(); err == nil {
		return strings.TrimSpace(out.String()), nil
	}
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "infra", "release", "images")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("not inside the LibreServ checkout (set LIBRESERV_REPO)")
		}
		dir = parent
	}
}

func newEngine() (*engine.Engine, error) {
	repo, err := repoRoot()
	if err != nil {
		return nil, err
	}
	return engine.New(engine.Config{Repo: repo})
}

// signalContext is cancelled on Ctrl-C / SIGTERM.
func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}
