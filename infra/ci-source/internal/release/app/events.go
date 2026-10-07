// Package app is the release tool's orchestration layer: build, cut, verify,
// serve-dev and secrets, with no output of its own. The CLI and the TUI both
// drive it, and watch progress through Events.
package app

import (
	"errors"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

// EventKind says which field of an Event is set.
type EventKind int

const (
	// EventBuild wraps an engine event (job queued/started/log/finished).
	EventBuild EventKind = iota
	// EventCut is a cut-step change: Step, Phase and Err.
	EventCut
	// EventNote is a one-line message from the orchestration itself.
	EventNote
	// EventPlan lists every job of a build before it starts (Plan).
	EventPlan
)

// JobInfo describes one job of a build graph.
type JobInfo struct {
	ID    string
	Title string
	Deps  []string
	Heavy bool
}

// Cut phases (Event.Phase).
const (
	PhaseStart   = "start"
	PhaseDone    = "done"
	PhaseSkipped = "skipped" // finished in an earlier run (resume)
	PhaseFailed  = "failed"
)

// Event is one progress report. Events are delivered one at a time, in order.
type Event struct {
	Time time.Time
	Kind EventKind
	Unit string

	Build engine.Event // EventBuild

	Step  string // EventCut: publish.Step* name
	Phase string // EventCut
	Err   error  // EventCut with PhaseFailed

	Message string // EventNote, and a short text for EventCut

	Plan []JobInfo // EventPlan
}

// emitter serialises delivery to one callback.
type emitter struct {
	mu  sync.Mutex
	fn  func(Event)
	now func() time.Time
	// redact scrubs secrets out of everything an event carries before the CLI
	// or the TUI can print it.
	redact func(string) string
}

func (e *emitter) scrub(ev Event) Event {
	if e.redact == nil {
		return ev
	}
	fix := func(err error) error {
		if err == nil {
			return nil
		}
		if m := err.Error(); e.redact(m) != m {
			return errors.New(e.redact(m))
		}
		return err
	}
	ev.Err = fix(ev.Err)
	ev.Build.Err = fix(ev.Build.Err)
	ev.Message = e.redact(ev.Message)
	return ev
}

func (e *emitter) emit(ev Event) {
	if e == nil || e.fn == nil {
		return
	}
	if ev.Time.IsZero() {
		ev.Time = e.now()
	}
	ev = e.scrub(ev)
	e.mu.Lock()
	defer e.mu.Unlock()
	e.fn(ev)
}

func (e *emitter) note(unit, format string, args ...any) {
	e.emit(Event{Kind: EventNote, Unit: unit, Message: sprintf(format, args...)})
}
