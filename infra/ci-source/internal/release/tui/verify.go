package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
)

type verifyDoneMsg struct {
	res []app.Verification
	err error
}

type verifyScreen struct {
	sh      *shared
	units   []string
	idx     int
	running bool
	res     []app.Verification
	err     error
	cancel  context.CancelFunc
	started time.Time
}

func newVerify(sh *shared, unit string) *verifyScreen {
	s := &verifyScreen{sh: sh, units: sh.be.Units()}
	for i, u := range s.units {
		if u == unit {
			s.idx = i
		}
	}
	return s
}

func (s *verifyScreen) init() tea.Cmd { return s.start() }
func (s *verifyScreen) busy() string {
	if s.running {
		return "verify"
	}
	return ""
}
func (s *verifyScreen) stop() {
	if s.cancel != nil {
		s.cancel()
	}
}

func (s *verifyScreen) start() tea.Cmd {
	if len(s.units) == 0 {
		return nil
	}
	s.running, s.res, s.err, s.started = true, nil, nil, s.sh.now()
	ctx, cancel := context.WithCancel(s.sh.ctx)
	s.cancel = cancel
	sh, unit := s.sh, s.units[s.idx]
	return func() tea.Msg {
		defer cancel()
		res, err := sh.be.Verify(ctx, unit, "")
		return verifyDoneMsg{res, err}
	}
}

func (s *verifyScreen) update(msg tea.Msg) (screen, tea.Cmd) {
	switch m := msg.(type) {
	case verifyDoneMsg:
		s.running, s.res, s.err, s.cancel = false, m.res, m.err, nil
	case tea.KeyMsg:
		if s.running {
			return s, nil
		}
		switch m.String() {
		case "esc", "q":
			return s, pop()
		case "r":
			return s, s.start()
		case "left", "h", "right", "l":
			d := 1
			if m.String() == "left" || m.String() == "h" {
				d = -1
			}
			s.idx = (s.idx + d + len(s.units)) % len(s.units)
			return s, s.start()
		}
	}
	return s, nil
}

func (s *verifyScreen) view(w, h int) frame {
	f := frame{title: "Verify " + s.units[s.idx], help: "←→ other unit · r check again · esc back"}
	if s.running {
		f.help = "esc/ctrl-c stop"
		f.info = clock(s.sh.now().Sub(s.started))
		f.body = []string{dimStyle.Render("  Checking each feed's signature, then every file's size and hash…")}
		return f
	}
	var lines []string
	if s.err != nil {
		lines = append(lines, "  "+failStyle.Render("✗ ")+fit(s.sh.redact(s.err.Error()), w-6))
	}
	for _, v := range s.res {
		if v.OK() {
			ver, parts := "", 0
			if v.Feed != nil {
				ver, parts = v.Feed.Version, len(v.Feed.Parts)
			}
			lines = append(lines, fmt.Sprintf("  %s %-7s %s · %s match the feed", okStyle.Render("✓"), v.Channel, ver, plural(parts, "file", "files")))
		} else {
			lines = append(lines, fmt.Sprintf("  %s %-7s %s", failStyle.Render("✗"), v.Channel, errTxtStyle.Render(fit(s.sh.redact(firstLine(v.Err.Error())), w-16))))
			for _, l := range strings.Split(v.Err.Error(), "\n")[1:] {
				lines = append(lines, "      "+dimStyle.Render(fit(s.sh.redact(l), w-8)))
			}
		}
		lines = append(lines, "    "+dimStyle.Render(fit(v.URL, w-6)))
	}
	f.body = lines
	return f
}

// ---- serve-dev

type (
	serveStartedMsg struct {
		srv *app.DevServer
		err error
	}
	serveEndedMsg struct{ err error }
)

type serveScreen struct {
	sh     *shared
	srv    *app.DevServer
	err    error
	ended  bool
	cancel context.CancelFunc
	wait   bool
}

func newServe(sh *shared) *serveScreen { return &serveScreen{sh: sh} }

func (s *serveScreen) busy() string { return "" }
func (s *serveScreen) stop() {
	if s.cancel != nil {
		s.cancel()
	}
	if s.srv != nil {
		_ = s.srv.Close()
	}
}

func (s *serveScreen) init() tea.Cmd {
	sh := s.sh
	return func() tea.Msg {
		srv, err := sh.be.StartDev(app.DevServeOptions{})
		return serveStartedMsg{srv, err}
	}
}

func (s *serveScreen) update(msg tea.Msg) (screen, tea.Cmd) {
	switch m := msg.(type) {
	case serveStartedMsg:
		s.srv, s.err = m.srv, m.err
		if m.err != nil {
			return s, nil
		}
		ctx, cancel := context.WithCancel(s.sh.ctx)
		s.cancel = cancel
		srv := m.srv
		return s, func() tea.Msg { return serveEndedMsg{srv.Wait(ctx)} }
	case serveEndedMsg:
		s.ended = true
		if m.err != nil {
			s.err = m.err
		}
	case tea.KeyMsg:
		switch m.String() {
		case "esc", "q":
			s.stop()
			return s, pop()
		}
	}
	return s, nil
}

func (s *serveScreen) view(w, h int) frame {
	f := frame{title: "Serve a test feed", help: "esc stop serving and go back"}
	switch {
	case s.err != nil:
		f.body = []string{"  " + failStyle.Render("✗ ") + fit(s.sh.redact(s.err.Error()), w-6)}
	case s.srv == nil:
		f.body = []string{dimStyle.Render("  Starting…")}
	default:
		state := okStyle.Render("● serving")
		if s.ended {
			state = dimStyle.Render("stopped")
		}
		f.body = []string{
			"  " + state + "  everything built into dist/",
			"",
			"  " + pad("Address", 12) + s.srv.URL,
			"  " + pad("Feeds", 12) + s.srv.FeedBase + "/<unit>/<channel>.json",
			"",
			"  " + dimStyle.Render("Feeds are signed with a throw-away test key. Point a Luna or Sol at the"),
			"  " + dimStyle.Render("feeds address and give it this public key to trust:"),
			"  " + pad("Test key ID", 12) + s.srv.Key.ID,
			"  " + pad("Public key", 12) + fit(s.srv.Key.PublicLine(), w-16),
		}
	}
	return f
}
