package tui

import (
	"context"
	"errors"
	"sync"

	tea "github.com/charmbracelet/bubbletea"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
)

type eventsMsg struct{}

type askMsg struct {
	q     secrets.Question
	reply chan secrets.Answer
}

// askGoneMsg tells the TUI that the question it shows is no longer waited for.
type askGoneMsg struct{ reply chan secrets.Answer }

// Bridge connects the orchestration layer to the running TUI: it is the
// app's event sink (OnEvent) and its secrets.Prompter. Create it before the
// app, pass both to app.Config, then give it to Run.
type Bridge struct {
	mu      sync.Mutex
	events  []app.Event
	pending bool
	send    func(tea.Msg)
	allow   int // open AllowAsk requests
}

// NewBridge makes a bridge that does not ask anything until a screen allows it.
func NewBridge() *Bridge { return &Bridge{} }

// Attach sets how messages reach the program (Run does this).
func (b *Bridge) Attach(send func(tea.Msg)) {
	b.mu.Lock()
	b.send = send
	b.mu.Unlock()
}

// OnEvent is app.Config.OnEvent. Events are collected and handed to the UI in
// batches, so a flood of log lines costs one redraw, not thousands.
func (b *Bridge) OnEvent(ev app.Event) {
	b.mu.Lock()
	b.events = append(b.events, ev)
	notify := !b.pending && b.send != nil
	if notify {
		b.pending = true
	}
	send := b.send
	b.mu.Unlock()
	if notify {
		send(eventsMsg{})
	}
}

func (b *Bridge) drain() []app.Event {
	b.mu.Lock()
	defer b.mu.Unlock()
	ev := b.events
	b.events, b.pending = nil, false
	return ev
}

// AllowAsk lets questions through until the returned function is called.
// Background checks run without it (a missing password just counts as
// missing); preflight and re-proving ask for it. Requests count, so one
// finishing never switches off another that is still running. The vault
// passphrase is never asked this way.
func (b *Bridge) AllowAsk() (done func()) {
	b.mu.Lock()
	b.allow++
	b.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			b.allow--
			b.mu.Unlock()
		})
	}
}

func (b *Bridge) asking() (bool, func(tea.Msg)) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.allow > 0 && b.send != nil, b.send
}

// Ask is secrets.Prompter: the question shows inline in the TUI and this
// call waits for the answer.
func (b *Bridge) Ask(ctx context.Context, q secrets.Question) (secrets.Answer, error) {
	if q.Slot == app.KeyringPassphraseSlot {
		return secrets.Answer{}, errors.New("the vault is locked")
	}
	ok, send := b.asking()
	if !ok {
		return secrets.Answer{Skip: true}, nil
	}
	reply := make(chan secrets.Answer, 1)
	send(askMsg{q: q, reply: reply})
	select {
	case a := <-reply:
		return a, nil
	case <-ctx.Done():
		send(askGoneMsg{reply})
		return secrets.Answer{}, ctx.Err()
	}
}

var _ secrets.Prompter = (*Bridge)(nil)
