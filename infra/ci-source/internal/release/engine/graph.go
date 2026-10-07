package engine

import (
	"context"
	"errors"
	"fmt"
	"runtime"
	"sync"
	"time"
)

// Status is a job's state.
type Status int

const (
	Pending   Status = iota // waiting for dependencies or a free slot
	Running                 // started
	Succeeded               // finished without error
	Failed                  // returned an error
	Cancelled               // was running when the build was cancelled
	Skipped                 // never started: a dependency failed or the build was cancelled
)

func (s Status) String() string {
	return [...]string{"pending", "running", "succeeded", "failed", "cancelled", "skipped"}[s]
}

// Done reports whether the status is final.
func (s Status) Done() bool { return s >= Succeeded }

// Job is one node of the build graph.
type Job struct {
	ID    string   // unique, e.g. "luna/lunad"
	Title string   // human label for the TUI (defaults to ID)
	Deps  []string // IDs that must succeed first
	// Heavy marks memory-hungry jobs (cargo link, gradle); they share the
	// smaller HeavyJobs cap on top of the overall Jobs cap.
	Heavy bool
	// Run does the work. Log lines go through JobRun.Log; honour ctx.
	Run func(ctx context.Context, j *JobRun) error
}

// JobRun is what a running job sees.
type JobRun struct {
	ID     string
	Engine *Engine
	log    LogFunc
}

// Log emits one line for this job (redacted before it leaves the engine).
func (j *JobRun) Log(line string) { j.log(line) }

// Logf is Log with formatting.
func (j *JobRun) Logf(format string, a ...any) { j.log(fmt.Sprintf(format, a...)) }

// Container runs spec in a toolchain image, streaming output into this job's
// log. Spec.Name defaults to the job ID.
func (j *JobRun) Container(ctx context.Context, spec RunSpec) error {
	if spec.Name == "" {
		spec.Name = j.ID
	}
	return j.Engine.Run(ctx, spec, j.log)
}

// EventType is the kind of an Event.
type EventType int

const (
	EventQueued    EventType = iota // job registered, once at start
	EventStarted                    // job began running
	EventLog                        // one log line
	EventFinished                   // job reached a final status (see Status/Err)
	EventGraphDone                  // all jobs final; Job is empty
)

// Event is delivered to Options.OnEvent. Events are delivered one at a time
// (never concurrently), in causal order per job.
type Event struct {
	Time    time.Time
	Type    EventType
	Job     string
	Line    string        // EventLog
	Status  Status        // EventFinished
	Err     error         // EventFinished with Failed
	Elapsed time.Duration // EventFinished
}

// Options control Graph.Run.
type Options struct {
	// Jobs is the overall parallelism (default: CPU count).
	Jobs int
	// HeavyJobs caps concurrent Heavy jobs (default: 2, never above Jobs).
	HeavyJobs int
	// FailFast cancels everything on the first failure.
	FailFast bool
	// OnEvent receives status/log events (may be nil).
	OnEvent func(Event)
	// Redactor is applied to every log line (nil: none).
	Redactor *Redactor
	// Engine is handed to jobs (may be nil for pure-Go jobs).
	Engine *Engine
}

// JobResult is a job's outcome.
type JobResult struct {
	ID       string
	Status   Status
	Err      error
	Start    time.Time
	End      time.Time
	Duration time.Duration
}

// Result is the outcome of a graph run, in job insertion order.
type Result struct {
	Jobs     []JobResult
	Duration time.Duration
}

// OK reports whether every job succeeded.
func (r *Result) OK() bool {
	for _, j := range r.Jobs {
		if j.Status != Succeeded {
			return false
		}
	}
	return true
}

// Get returns the result of one job.
func (r *Result) Get(id string) (JobResult, bool) {
	for _, j := range r.Jobs {
		if j.ID == id {
			return j, true
		}
	}
	return JobResult{}, false
}

// FirstError returns the first failed job's error, or context.Canceled when the
// run was stopped before every job finished.
func (r *Result) FirstError() error {
	for _, j := range r.Jobs {
		if j.Status == Failed {
			return fmt.Errorf("%s: %w", j.ID, j.Err)
		}
	}
	// Nothing failed, but a stop leaves jobs cancelled or never started.
	for _, j := range r.Jobs {
		if j.Status == Cancelled || j.Status == Skipped {
			return fmt.Errorf("%s: %w", j.ID, context.Canceled)
		}
	}
	return nil
}

// Graph is a set of jobs with dependencies.
type Graph struct {
	jobs  []Job
	index map[string]int
}

// NewGraph returns an empty graph.
func NewGraph() *Graph { return &Graph{index: map[string]int{}} }

// Add registers a job. Deps may refer to jobs added later; Validate checks.
func (g *Graph) Add(jobs ...Job) error {
	for _, j := range jobs {
		if j.ID == "" {
			return errors.New("job without ID")
		}
		if j.Run == nil {
			return fmt.Errorf("job %s has no Run", j.ID)
		}
		if _, dup := g.index[j.ID]; dup {
			return fmt.Errorf("duplicate job %q", j.ID)
		}
		g.index[j.ID] = len(g.jobs)
		g.jobs = append(g.jobs, j)
	}
	return nil
}

// Jobs returns the jobs in insertion order.
func (g *Graph) Jobs() []Job { return append([]Job(nil), g.jobs...) }

// Validate checks that every dependency exists and that there are no cycles.
func (g *Graph) Validate() error {
	for _, j := range g.jobs {
		for _, d := range j.Deps {
			if _, ok := g.index[d]; !ok {
				return fmt.Errorf("job %q depends on unknown job %q", j.ID, d)
			}
			if d == j.ID {
				return fmt.Errorf("job %q depends on itself", j.ID)
			}
		}
	}
	const (
		white = iota
		grey
		black
	)
	color := make([]int, len(g.jobs))
	var visit func(i int, path []string) error
	visit = func(i int, path []string) error {
		color[i] = grey
		for _, d := range g.jobs[i].Deps {
			k := g.index[d]
			switch color[k] {
			case grey:
				return fmt.Errorf("dependency cycle: %v -> %s", append(path, g.jobs[i].ID), d)
			case white:
				if err := visit(k, append(path, g.jobs[i].ID)); err != nil {
					return err
				}
			}
		}
		color[i] = black
		return nil
	}
	for i := range g.jobs {
		if color[i] == white {
			if err := visit(i, nil); err != nil {
				return err
			}
		}
	}
	return nil
}

type finished struct {
	idx int
	err error
	end time.Time
}

// Run executes the graph. It returns an error only for an invalid graph; job
// failures are in the Result. Cancelling ctx cancels running jobs.
func (g *Graph) Run(ctx context.Context, opts Options) (*Result, error) {
	if err := g.Validate(); err != nil {
		return nil, err
	}
	if opts.Jobs <= 0 {
		opts.Jobs = runtime.NumCPU()
	}
	if opts.HeavyJobs <= 0 {
		opts.HeavyJobs = 2
	}
	if opts.HeavyJobs > opts.Jobs {
		opts.HeavyJobs = opts.Jobs
	}

	var emitMu sync.Mutex
	emit := func(ev Event) {
		if opts.OnEvent == nil {
			return
		}
		ev.Time = time.Now()
		emitMu.Lock()
		defer emitMu.Unlock()
		opts.OnEvent(ev)
	}

	start := time.Now()
	runCtx, cancel := context.WithCancel(ctx)
	defer cancel()

	n := len(g.jobs)
	res := make([]JobResult, n)
	for i, j := range g.jobs {
		res[i] = JobResult{ID: j.ID}
		emit(Event{Type: EventQueued, Job: j.ID})
	}
	remaining := make([]int, n) // unfinished deps per job
	dependents := make([][]int, n)
	for i, j := range g.jobs {
		remaining[i] = len(j.Deps)
		for _, d := range j.Deps {
			dependents[g.index[d]] = append(dependents[g.index[d]], i)
		}
	}

	var ready []int // insertion-ordered
	for i := range g.jobs {
		if remaining[i] == 0 {
			ready = append(ready, i)
		}
	}

	doneCh := make(chan finished)
	running, runningHeavy, final := 0, 0, 0
	stopping := false // fail-fast or cancellation: start nothing new

	finish := func(i int, st Status, err error, started time.Time, end time.Time) {
		res[i].Status, res[i].Err, res[i].End = st, err, end
		if !started.IsZero() {
			res[i].Duration = end.Sub(started)
		}
		final++
		emit(Event{Type: EventFinished, Job: g.jobs[i].ID, Status: st, Err: err, Elapsed: res[i].Duration})
	}
	// skip marks job i and everything downstream of it as skipped.
	var skip func(i int, cause string)
	skip = func(i int, cause string) {
		if res[i].Status != Pending {
			return
		}
		res[i].Status = Skipped // reserve before recursing
		finish(i, Skipped, errors.New(cause), time.Time{}, time.Now())
		for _, d := range dependents[i] {
			skip(d, cause)
		}
	}

	launch := func(i int) {
		j := g.jobs[i]
		res[i].Status = Running
		res[i].Start = time.Now()
		running++
		if j.Heavy {
			runningHeavy++
		}
		emit(Event{Type: EventStarted, Job: j.ID})
		jr := &JobRun{ID: j.ID, Engine: opts.Engine}
		jr.log = func(line string) {
			emit(Event{Type: EventLog, Job: j.ID, Line: opts.Redactor.Redact(line)})
		}
		go func() {
			var err error
			func() {
				defer func() {
					if r := recover(); r != nil {
						err = fmt.Errorf("panic: %v", r)
					}
				}()
				err = j.Run(runCtx, jr)
			}()
			doneCh <- finished{idx: i, err: err, end: time.Now()}
		}()
	}

	for final < n {
		if !stopping && runCtx.Err() != nil {
			stopping = true
		}
		if stopping {
			// Anything not yet started will never run.
			for i := range g.jobs {
				if res[i].Status == Pending {
					skip(i, "cancelled before start")
				}
			}
			ready = nil
		} else {
			// Start ready jobs in insertion order, honouring both caps.
			var rest []int
			for _, i := range ready {
				heavy := g.jobs[i].Heavy
				if running >= opts.Jobs || (heavy && runningHeavy >= opts.HeavyJobs) {
					rest = append(rest, i)
					continue
				}
				launch(i)
			}
			ready = rest
		}
		if final >= n {
			break
		}
		if running == 0 {
			if len(ready) == 0 {
				break // unreachable for a validated graph
			}
			continue
		}

		var f finished
		select {
		case f = <-doneCh:
		case <-runCtx.Done():
			f = <-doneCh // jobs are expected to return once cancelled
		}
		i := f.idx
		running--
		if g.jobs[i].Heavy {
			runningHeavy--
		}
		switch {
		case f.err == nil:
			finish(i, Succeeded, nil, res[i].Start, f.end)
			for _, d := range dependents[i] {
				remaining[d]--
				if remaining[d] == 0 && res[d].Status == Pending {
					ready = append(ready, d)
				}
			}
		case runCtx.Err() != nil && (errors.Is(f.err, context.Canceled) || errors.Is(f.err, context.DeadlineExceeded)):
			finish(i, Cancelled, f.err, res[i].Start, f.end)
			for _, d := range dependents[i] {
				skip(d, "dependency "+g.jobs[i].ID+" was cancelled")
			}
		default:
			finish(i, Failed, f.err, res[i].Start, f.end)
			for _, d := range dependents[i] {
				skip(d, "dependency "+g.jobs[i].ID+" failed")
			}
			if opts.FailFast {
				stopping = true
				cancel()
			}
		}
	}

	out := &Result{Jobs: res, Duration: time.Since(start)}
	emit(Event{Type: EventGraphDone})
	return out, nil
}
