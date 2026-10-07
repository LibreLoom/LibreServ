package tui

import (
	"context"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
)

// frame is what a screen shows: a title line, a body of exactly the lines
// asked for, and a help line.
type frame struct {
	title string
	info  string
	body  []string
	help  string
}

type screen interface {
	init() tea.Cmd
	update(msg tea.Msg) (screen, tea.Cmd)
	view(w, h int) frame
	// busy names the work that Ctrl-C and Esc must confirm stopping
	// ("build", "cut", "verify"), or "" when the screen is idle.
	busy() string
	// stop cancels running work (the user confirmed, or the tool is closing).
	stop()
}

// shared is what every screen can reach.
type shared struct {
	be     Backend
	br     *Bridge
	run    *runState
	now    func() time.Time
	w, h   int
	ctx    context.Context
	cancel context.CancelFunc
}

func (s *shared) redact(x string) string { return s.be.Redact(x) }

func (s *shared) newRun() *runState {
	s.run = newRunState(s.now())
	return s.run
}

type (
	pushMsg    struct{ s screen }
	popMsg     struct{}
	replaceMsg struct{ s screen }
	tickMsg    time.Time
	// storeStateMsg is the result of looking at the store when starting.
	storeStateMsg struct{ needUnlock bool }
	// storeReadyMsg means remembered values can be read (or the user went on
	// without them): background checks may start.
	storeReadyMsg struct{}
)

func push(s screen) tea.Cmd { return func() tea.Msg { return pushMsg{s} } }
func pop() tea.Cmd          { return func() tea.Msg { return popMsg{} } }
func replace(s screen) tea.Cmd {
	return func() tea.Msg { return replaceMsg{s} }
}
func send(m tea.Msg) tea.Cmd { return func() tea.Msg { return m } }

// Model is the root bubbletea model.
type Model struct {
	sh    *shared
	stack []screen
	ask   *askState
	conf  *confirmState
	// Done is closed when the model quits (tests).
	quit bool
}

type confirmState struct {
	text []string
	yes  func() tea.Cmd
}

// New builds the TUI. br must be the bridge the app was created with.
func New(be Backend, br *Bridge) *Model {
	ctx, cancel := context.WithCancel(context.Background())
	sh := &shared{be: be, br: br, now: time.Now, w: 80, h: 24, ctx: ctx, cancel: cancel}
	sh.run = newRunState(sh.now())
	m := &Model{sh: sh}
	m.stack = []screen{newHome(sh)}
	return m
}

// Init starts loading the home data and looks at the store.
func (m *Model) Init() tea.Cmd {
	return tea.Batch(m.stack[0].init(), storeCmd(m.sh), tickCmd())
}

func tickCmd() tea.Cmd {
	return tea.Tick(500*time.Millisecond, func(t time.Time) tea.Msg { return tickMsg(t) })
}

// storeCmd looks at the store: which one is active and whether it needs the
// passphrase. It can take a moment (it probes the system keyring).
func storeCmd(sh *shared) tea.Cmd {
	return func() tea.Msg {
		st := sh.be.Store()
		if st == nil {
			return storeStateMsg{}
		}
		return storeStateMsg{needUnlock: st.NeedsUnlock()}
	}
}

func (m *Model) top() screen { return m.stack[len(m.stack)-1] }

func (m *Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.sh.w, m.sh.h = msg.Width, msg.Height
		return m, nil
	case tickMsg:
		return m, tickCmd()
	case eventsMsg:
		for _, ev := range m.sh.br.drain() {
			m.sh.run.apply(ev, m.sh.redact)
		}
		return m, nil
	case askMsg:
		m.ask = newAsk(m.sh, msg)
		return m, nil
	case askGoneMsg:
		if m.ask != nil && m.ask.reply == msg.reply {
			m.ask = nil
		}
		return m, nil
	case pushMsg:
		m.stack = append(m.stack, msg.s)
		return m, msg.s.init()
	case replaceMsg:
		m.stack[len(m.stack)-1] = msg.s
		return m, msg.s.init()
	case popMsg:
		if len(m.stack) > 1 {
			m.stack = m.stack[:len(m.stack)-1]
		}
		return m, nil
	case storeStateMsg:
		if msg.needUnlock {
			return m, push(newUnlock(m.sh, func() tea.Cmd { return send(storeReadyMsg{}) }))
		}
		return m, send(storeReadyMsg{})
	case storeReadyMsg:
		s, cmd := m.stack[0].update(msg)
		m.stack[0] = s
		return m, cmd
	case tea.KeyMsg:
		if c, handled := m.key(msg); handled {
			return m, c
		}
	}
	s, cmd := m.top().update(msg)
	m.stack[len(m.stack)-1] = s
	if m.quit {
		return m, tea.Quit
	}
	return m, cmd
}

// key handles what is above the screens: an open question, an open
// confirmation, and Ctrl-C.
func (m *Model) key(k tea.KeyMsg) (tea.Cmd, bool) {
	switch {
	case m.ask != nil:
		if done := m.ask.key(k); done {
			m.ask = nil
		}
		return nil, true
	case m.conf != nil:
		c := m.conf
		switch k.String() {
		case "y", "Y", "enter":
			m.conf = nil
			return c.yes(), true
		case "n", "N", "esc", "ctrl+c":
			m.conf = nil
		}
		return nil, true
	}
	busy := m.top().busy()
	switch k.String() {
	case "ctrl+c":
		if busy != "" {
			return m.confirmStop(busy), true
		}
		m.shutdown()
		return tea.Quit, true
	case "esc":
		if c, ok := m.top().(interface{ consumesEsc() bool }); ok && c.consumesEsc() {
			return nil, false
		}
		if busy != "" {
			return m.confirmStop(busy), true
		}
	}
	return nil, false
}

func (m *Model) shutdown() {
	for _, s := range m.stack {
		s.stop()
	}
	m.sh.cancel()
}

func (m *Model) confirmStop(kind string) tea.Cmd {
	var text []string
	switch kind {
	case "cut":
		if m.sh.run.bumpDone {
			text = []string{"Stop the cut?", "Steps already done stay done. Resume it later from Home with r."}
		} else {
			text = []string{"Stop the cut?", "Nothing has been pushed yet, so nothing needs undoing."}
		}
	case "build":
		text = []string{"Stop the build?", "Running jobs are cancelled. Nothing is published."}
	default:
		text = []string{"Stop this check?"}
	}
	m.conf = &confirmState{text: text, yes: func() tea.Cmd {
		m.top().stop()
		return nil
	}}
	return nil
}

// View draws header, body, footer: exactly the terminal's size.
func (m *Model) View() string {
	w, h := m.sh.w, m.sh.h
	if w < 20 || h < 6 {
		return "Terminal too small"
	}
	bodyH := h - 4
	var panel []string
	help := ""
	switch {
	case m.ask != nil:
		panel, help = m.ask.view(w)
	case m.conf != nil:
		panel = append([]string{}, m.conf.text...)
		for i := range panel {
			panel[i] = "  " + panel[i]
		}
		for i := 1; i < len(panel); i++ {
			panel[i] = "  " + panel[i]
		}
		panel[0] = "  " + warnStyle.Render("?") + " " + panelStyle.Render(strings.TrimSpace(panel[0]))
		help = "y stop · n keep going"
	}
	bodyH -= len(panel)
	f := m.top().view(w, bodyH)
	if help == "" {
		help = f.help
	}
	left := " " + titleStyle.Render(f.title)
	right := infoStyle.Render(f.info) + " "
	gap := w - lw(left) - lw(right)
	var head string
	if gap < 1 {
		head = fit(left, w)
	} else {
		head = left + strings.Repeat(" ", gap) + right
	}
	lines := []string{head, rule(w)}
	for _, l := range fill(f.body, bodyH) {
		lines = append(lines, fit(l, w))
	}
	lines = append(lines, panel...)
	lines = append(lines, rule(w), helpStyle.Render(" "+fit(help, w-2)))
	return strings.Join(lines, "\n")
}

// ---- inline question (the secrets.Prompter's other half)

type askState struct {
	sh       *shared
	q        secrets.Question
	reply    chan secrets.Answer
	f        *field
	remember bool
	canStore bool
}

func newAsk(sh *shared, m askMsg) *askState {
	a := &askState{sh: sh, q: m.q, reply: m.reply}
	a.f = newField("", m.q.Secret)
	if st := sh.be.Store(); st != nil && st.Unlocked() {
		a.canStore = true
		a.remember = true
	}
	return a
}

func (a *askState) key(k tea.KeyMsg) (done bool) {
	switch k.Type {
	case tea.KeyEnter:
		if a.f.empty() {
			return false
		}
		a.reply <- secrets.Answer{Value: a.f.text(), Remember: a.canStore && a.remember}
		return true
	case tea.KeyEsc, tea.KeyCtrlC:
		a.reply <- secrets.Answer{Skip: true}
		return true
	case tea.KeyTab:
		if a.canStore {
			a.remember = !a.remember
		}
		return false
	}
	a.f.handle(k)
	return false
}

func (a *askState) view(w int) ([]string, string) {
	store := ""
	if a.canStore {
		store = "   " + checkbox(a.remember) + " Remember"
	}
	lines := []string{"  " + warnStyle.Render("?") + " " + panelStyle.Render(fit(a.q.Label, w-6))}
	if a.q.Hint != "" {
		lines = append(lines, "    "+dimStyle.Render(fit(a.q.Hint, w-6)))
	}
	lines = append(lines, "    "+pad(a.f.view(w-30, true), w-30)+store)
	help := "enter use it · esc skip"
	if a.canStore {
		help = "enter use it · tab remember · esc skip"
	}
	return lines, help
}

// Run starts the TUI on the terminal and returns when the user quits.
func Run(be Backend, br *Bridge) error {
	m := New(be, br)
	p := tea.NewProgram(m, tea.WithAltScreen())
	br.Attach(p.Send)
	_, err := p.Run()
	m.shutdown()
	return err
}

// Redactions: nothing a screen prints may carry a value; see Backend.Redact.
var _ = app.CheckOK
