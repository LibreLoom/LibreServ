package tui

import (
	"context"

	tea "github.com/charmbracelet/bubbletea"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
)

type doctorDoneMsg struct{ rep *app.DoctorReport }

type doctorScreen struct {
	sh  *shared
	rep *app.DoctorReport
	off int
}

func newDoctor(sh *shared) *doctorScreen { return &doctorScreen{sh: sh} }
func (s *doctorScreen) busy() string     { return "" }
func (s *doctorScreen) stop()            {}

func (s *doctorScreen) init() tea.Cmd {
	sh := s.sh
	return func() tea.Msg {
		sh.br.SetAsk(false)
		return doctorDoneMsg{sh.be.Doctor(context.Background(), true)}
	}
}

func (s *doctorScreen) update(msg tea.Msg) (screen, tea.Cmd) {
	switch m := msg.(type) {
	case doctorDoneMsg:
		s.rep = m.rep
	case tea.KeyMsg:
		switch m.String() {
		case "esc", "q":
			return s, pop()
		case "r":
			s.rep, s.off = nil, 0
			return s, s.init()
		case "up", "k":
			s.off = max(s.off-1, 0)
		case "down", "j":
			s.off++
		case "pgup":
			s.off = max(s.off-10, 0)
		case "pgdown":
			s.off += 10
		}
	}
	return s, nil
}

func (s *doctorScreen) view(w, h int) frame {
	f := frame{title: "Doctor", help: "↑↓ scroll · r check again · esc back"}
	if s.rep == nil {
		f.body = []string{dimStyle.Render("  Checking podman, caches, images and secrets…")}
		return f
	}
	var lines []string
	for _, sec := range s.rep.Sections {
		lines = append(lines, " "+selStyle.Render(sec.Title))
		for _, c := range sec.Checks {
			g := map[string]string{app.CheckOK: okStyle.Render("✓"), app.CheckWarn: warnStyle.Render("!"), app.CheckFail: failStyle.Render("✗")}[c.State]
			lines = append(lines, "   "+g+" "+pad(c.Name, 22)+fit(s.sh.redact(c.Detail), w-30))
		}
	}
	s.off = min(s.off, max(len(lines)-h, 0))
	f.body = lines[s.off:]
	switch {
	case s.rep.Failed():
		f.info = "problems found"
	case s.rep.Warned():
		f.info = "ok, with warnings"
	default:
		f.info = "all good"
	}
	return f
}
