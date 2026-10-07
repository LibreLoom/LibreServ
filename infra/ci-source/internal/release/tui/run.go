package tui

import (
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
)

const maxLogLines = 3000

// jobRow is one build job as the TUI knows it.
type jobRow struct {
	ID      string
	Title   string
	Deps    []string
	Heavy   bool
	Status  engine.Status
	Started time.Time
	Elapsed time.Duration
	Err     string
	Log     []string
	LogN    int // lines ever logged (Log keeps the last maxLogLines)
}

// stepRow is one step of a cut.
type stepRow struct {
	Name   string
	Phase  string // "", start, done, skipped, failed
	Err    string
	Detail string
}

// runState is everything learned from events during a build or cut.
type runState struct {
	jobs    []*jobRow
	byID    map[string]*jobRow
	steps   []*stepRow
	notes   []string
	started time.Time
	// bumpDone is true once the bump commit exists (a stopped cut can be resumed).
	bumpDone bool
	// multiUnit is true when jobs of more than one unit are listed.
	multiUnit bool
}

func newRunState(now time.Time) *runState {
	r := &runState{byID: map[string]*jobRow{}, started: now}
	for _, s := range publish.Steps {
		r.steps = append(r.steps, &stepRow{Name: s})
	}
	return r
}

func (r *runState) job(id string) *jobRow {
	j := r.byID[id]
	if j == nil {
		j = &jobRow{ID: id, Title: id}
		r.byID[id] = j
		r.jobs = append(r.jobs, j)
	}
	return j
}

func (r *runState) note(s string) {
	r.notes = append(r.notes, s)
	if len(r.notes) > 200 {
		r.notes = r.notes[len(r.notes)-200:]
	}
}

// apply folds one event in.
func (r *runState) apply(ev app.Event, redact func(string) string) {
	switch ev.Kind {
	case app.EventPlan:
		for _, p := range ev.Plan {
			j := r.job(p.ID)
			j.Title, j.Deps, j.Heavy = p.Title, p.Deps, p.Heavy
		}
	case app.EventNote:
		r.note(redact(ev.Message))
	case app.EventCut:
		for _, s := range r.steps {
			if s.Name != ev.Step {
				continue
			}
			s.Phase = ev.Phase
			if ev.Err != nil {
				s.Err = redact(ev.Err.Error())
			}
			if ev.Phase == app.PhaseDone || ev.Phase == app.PhaseSkipped {
				if s.Name == publish.StepBump {
					r.bumpDone = true
				}
			}
		}
	case app.EventBuild:
		b := ev.Build
		switch b.Type {
		case engine.EventQueued:
			r.job(b.Job)
		case engine.EventStarted:
			j := r.job(b.Job)
			j.Status, j.Started = engine.Running, b.Time
		case engine.EventLog:
			j := r.job(b.Job)
			j.LogN++
			line := b.Line
			if len(line) > 400 {
				line = line[:400]
			}
			j.Log = append(j.Log, redact(strings.TrimRight(line, "\r\n")))
			if len(j.Log) > maxLogLines {
				j.Log = j.Log[len(j.Log)-maxLogLines:]
			}
		case engine.EventFinished:
			j := r.job(b.Job)
			j.Status, j.Elapsed = b.Status, b.Elapsed
			if b.Err != nil {
				j.Err = redact(b.Err.Error())
			}
		}
	}
	units := map[string]bool{}
	for _, j := range r.jobs {
		u, _, _ := strings.Cut(j.ID, "/")
		units[u] = true
	}
	r.multiUnit = len(units) > 1
}

// name is the job's short name for display.
func (r *runState) name(j *jobRow) string {
	if r.multiUnit {
		return j.ID
	}
	_, rest, ok := strings.Cut(j.ID, "/")
	if ok {
		return rest
	}
	return j.ID
}

// waitsFor lists the dependencies that have not succeeded yet.
func (r *runState) waitsFor(j *jobRow) []string {
	var out []string
	for _, d := range j.Deps {
		if dj := r.byID[d]; dj == nil || dj.Status != engine.Succeeded {
			out = append(out, r.name(&jobRow{ID: d}))
		}
	}
	return out
}

func (r *runState) running() int {
	n := 0
	for _, j := range r.jobs {
		if j.Status == engine.Running {
			n++
		}
	}
	return n
}
