package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/version"
)

// repoFlag is the global --repo value.
var repoFlag string

// repoRoot finds the checkout: --repo, else $LIBRESERV_REPO, else git's top
// level of the working directory, else the first parent holding
// infra/release/images.
func repoRoot() (string, error) {
	if repoFlag != "" {
		return filepath.Abs(repoFlag)
	}
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
			return "", fmt.Errorf("not inside the LibreServ checkout (use --repo or set LIBRESERV_REPO)")
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

// appOpts tune newApp.
type appOpts struct {
	prompt  bool // ask for missing secrets on the terminal (when there is one)
	events  func(app.Event)
	outRoot string
	keyring bool // open the OS keyring
}

// newApp builds the orchestration layer for a command.
func newApp(o appOpts) (*app.App, error) {
	repo, err := repoRoot()
	if err != nil {
		return nil, err
	}
	registerDemo()
	cfg := app.Config{Repo: repo, OnEvent: o.events, OutRoot: o.outRoot, NoKeyring: !o.keyring}
	if o.prompt {
		if p := terminalPrompter(); p != nil {
			cfg.Prompter = p
		}
	}
	cfg.DevVersion = devVersion
	cfg.FeedSpecs = feedSpecs
	cfg.VersionFiles = versionFiles()
	return app.New(cfg)
}

// signalContext is cancelled on Ctrl-C / SIGTERM.
func signalContext() (context.Context, context.CancelFunc) {
	return signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
}

func printJSON(v any) {
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	enc.Encode(v)
}

// parseInterspersed parses flags that may come before or after positional
// arguments (`build luna --ref X`) and returns the positionals.
func parseInterspersed(fs *flag.FlagSet, args []string) ([]string, error) {
	fs.SetOutput(os.Stderr)
	var pos []string
	for {
		if err := fs.Parse(args); err != nil {
			return nil, err
		}
		if fs.NArg() == 0 {
			return pos, nil
		}
		pos = append(pos, fs.Arg(0))
		args = fs.Args()[1:]
	}
}

func fail(cmd string, err error) int {
	fmt.Fprintf(os.Stderr, "release %s: %v\n", cmd, err)
	return 1
}

func usageErr(cmd, msg string) int {
	fmt.Fprintf(os.Stderr, "release %s: %s\n", cmd, msg)
	return 2
}

// humanSize formats bytes.
func humanSize(n int64) string {
	const k = 1024.0
	f := float64(n)
	switch {
	case f >= k*k*k:
		return fmt.Sprintf("%.1f GB", f/(k*k*k))
	case f >= k*k:
		return fmt.Sprintf("%.1f MB", f/(k*k))
	case f >= k:
		return fmt.Sprintf("%.1f KB", f/k)
	}
	return fmt.Sprintf("%d B", n)
}

// eventPrinter prints progress lines to w (stderr, so stdout stays results).
func eventPrinter(w io.Writer) func(app.Event) {
	return func(ev app.Event) {
		switch ev.Kind {
		case app.EventNote:
			fmt.Fprintf(w, "[release] %s\n", ev.Message)
		case app.EventCut:
			switch ev.Phase {
			case app.PhaseStart:
				fmt.Fprintf(w, "[cut] %s ...\n", ev.Step)
			case app.PhaseDone:
				fmt.Fprintf(w, "[cut] %s done\n", ev.Step)
			case app.PhaseSkipped:
				fmt.Fprintf(w, "[cut] %s done earlier\n", ev.Step)
			case app.PhaseFailed:
				fmt.Fprintf(w, "[cut] %s failed: %v\n", ev.Step, ev.Err)
			}
		case app.EventBuild:
			b := ev.Build
			switch b.Type {
			case engine.EventStarted:
				fmt.Fprintf(w, "[%s] started\n", b.Job)
			case engine.EventLog:
				fmt.Fprintf(w, "[%s] %s\n", b.Job, b.Line)
			case engine.EventFinished:
				if b.Err != nil {
					fmt.Fprintf(w, "[%s] %s: %v\n", b.Job, b.Status, b.Err)
				} else {
					fmt.Fprintf(w, "[%s] %s in %s\n", b.Job, b.Status, b.Elapsed.Round(10_000_000))
				}
			}
		}
	}
}

func versionFiles() map[string]string {
	m := map[string]string{}
	for k, v := range version.Units {
		m[k] = v
	}
	return m
}
