package runner

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// SlotPool is the machine-wide set of job slots. Every ci process on this
// machine takes one slot per running job, so the universal parallelism bound
// holds across runs; each slot carries an equal share of the CPU and memory
// bounds. A slot is an flock on a file in the user's cache directory: the
// kernel drops it when the holder exits, even if it was killed.
type SlotPool struct {
	dir string
	n   int
}

// NewSlotPool opens the pool of n slots, creating its directory if needed.
func NewSlotPool(n int) (*SlotPool, error) {
	base, err := os.UserCacheDir()
	if err != nil {
		return nil, err
	}
	return newSlotPoolIn(filepath.Join(base, "libreserv-ci", "slots"), n)
}

func newSlotPoolIn(dir string, n int) (*SlotPool, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &SlotPool{dir: dir, n: max(n, 1)}, nil
}

// Acquire blocks until a slot is free or ctx ends, and returns its release
// func. onWait runs once, the first time every slot is taken.
func (p *SlotPool) Acquire(ctx context.Context, onWait func()) (func(), error) {
	waited := false
	for {
		for i := 0; i < p.n; i++ {
			f, err := os.OpenFile(filepath.Join(p.dir, fmt.Sprintf("slot-%d.lock", i)), os.O_CREATE|os.O_RDWR, 0o600)
			if err != nil {
				return nil, err
			}
			if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err == nil {
				return func() { f.Close() }, nil // closing drops the lock
			}
			f.Close()
		}
		if !waited {
			waited = true
			if onWait != nil {
				onWait()
			}
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(500 * time.Millisecond):
		}
	}
}
