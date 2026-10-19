package main

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"
)

// ciGate runs ./ci profiles for a cut. A release should not wait on a polite
// test run, so it opts out of the universal bounds (-session with no limits);
// everything else about ./ci still applies, including stopping its containers
// if this tool dies.
func ciGate(repo string) func(ctx context.Context, profiles []string, log func(string)) error {
	return func(ctx context.Context, profiles []string, log func(string)) error {
		for _, p := range profiles {
			if err := runCI(ctx, repo, p, log); err != nil {
				return fmt.Errorf("./ci profile %q: %w", p, err)
			}
		}
		return nil
	}
}

func runCI(ctx context.Context, repo, profile string, log func(string)) error {
	cmd := exec.CommandContext(ctx, filepath.Join(repo, "ci"), "run", "-profile", profile, "-session")
	cmd.Dir = repo
	cmd.Cancel = func() error { return cmd.Process.Signal(syscall.SIGINT) } // lets ci stop its containers
	cmd.WaitDelay = 30 * time.Second
	r, w, err := os.Pipe()
	if err != nil {
		return err
	}
	cmd.Stdout, cmd.Stderr = w, w
	if err := cmd.Start(); err != nil {
		r.Close()
		w.Close()
		return err
	}
	w.Close()
	done := make(chan struct{})
	go func() {
		defer close(done)
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64*1024), 1<<20)
		for sc.Scan() {
			log(sc.Text())
		}
	}()
	err = cmd.Wait()
	r.Close()
	<-done
	return err
}
