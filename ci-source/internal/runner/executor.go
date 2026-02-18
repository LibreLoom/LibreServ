package runner

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/tests"
)

type Executor struct {
	runner       *Runner
	cfg          *config.Config
	cancel       context.CancelFunc
	cancelMu     sync.Mutex
	cancelled    bool
	skipTestChan chan string
}

func NewExecutor(cfg *config.Config) (*Executor, error) {
	runner, err := NewRunner(cfg)
	if err != nil {
		return nil, err
	}
	return &Executor{
		runner:       runner,
		cfg:          cfg,
		skipTestChan: make(chan string, 10),
	}, nil
}

func (e *Executor) Execute(profile string, testIDs []string, parallelism int, failFast bool, fuzzDuration time.Duration, cpuQuota int64, memoryLimit int64) *RunSummary {
	ctx, cancel := context.WithCancel(context.Background())

	e.cancelMu.Lock()
	e.cancel = cancel
	e.cancelled = false
	e.cancelMu.Unlock()

	sigChan := make(chan os.Signal, 1)
	signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		select {
		case <-sigChan:
			fmt.Println("\nReceived interrupt signal, cancelling...")
			cancel()
		case <-ctx.Done():
		}
		signal.Stop(sigChan)
	}()

	opts := RunOptions{
		Profile:      profile,
		TestIDs:      testIDs,
		Parallelism:  parallelism,
		FailFast:     failFast,
		FuzzDuration: fuzzDuration,
		SkipTestChan: e.skipTestChan,
		CPUQuota:     cpuQuota,
		MemoryLimit:  memoryLimit,
	}

	summary := e.runner.Run(ctx, opts)
	return summary
}

func (e *Executor) Cancel() {
	e.cancelMu.Lock()
	defer e.cancelMu.Unlock()
	if e.cancel != nil && !e.cancelled {
		e.cancelled = true
		e.cancel()
	}
}

func (e *Executor) SkipTest(testID string) {
	select {
	case e.skipTestChan <- testID:
	default:
	}
}

func (e *Executor) OutputChan() <-chan OutputLine {
	return e.runner.OutputChan()
}

func (e *Executor) ResultChan() <-chan *tests.TestResult {
	return e.runner.ResultChan()
}

func (e *Executor) Close() error {
	return e.runner.Close()
}

func (e *Executor) ListTests() []*tests.Test {
	return tests.DefaultRegistry.List()
}

func (e *Executor) ListProfiles() []*config.Profile {
	return config.ListProfiles()
}
