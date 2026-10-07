package tui

import (
	"errors"

	tea "github.com/charmbracelet/bubbletea"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
)

type unlockResultMsg struct{ err error }

// unlockScreen asks for the vault passphrase (or a new one, when there is no
// vault yet). The passphrase stays in memory for this session only.
type unlockScreen struct {
	sh       *shared
	onDone   func() tea.Cmd
	onSkip   func() tea.Cmd
	creating bool
	a, b     *field
	focus    int
	err      string
	working  bool
}

func newUnlock(sh *shared, onDone func() tea.Cmd) *unlockScreen {
	s := &unlockScreen{sh: sh, onDone: onDone, a: newField("", true), b: newField("", true)}
	s.onSkip = func() tea.Cmd { return send(storeReadyMsg{}) }
	if sh.snap.have {
		s.creating = !sh.snap.vaultExists
	}
	return s
}

func (s *unlockScreen) init() tea.Cmd { return nil }
func (s *unlockScreen) busy() string  { return "" }
func (s *unlockScreen) stop()         {}

func (s *unlockScreen) update(msg tea.Msg) (screen, tea.Cmd) {
	switch m := msg.(type) {
	case unlockResultMsg:
		s.working = false
		switch {
		case m.err == nil:
			var after tea.Cmd
			if s.onDone != nil {
				after = s.onDone()
			}
			return s, tea.Sequence(pop(), after)
		case errors.Is(m.err, secrets.ErrWrongPassphrase):
			s.err = "That passphrase is wrong. Try again."
			s.a.clear()
		default:
			s.err = s.sh.redact(m.err.Error())
		}
		return s, nil
	case tea.KeyMsg:
		if s.working {
			return s, nil
		}
		switch m.Type {
		case tea.KeyEsc:
			var after tea.Cmd
			if s.onSkip != nil {
				after = s.onSkip()
			}
			return s, tea.Sequence(pop(), after)
		case tea.KeyTab, tea.KeyDown, tea.KeyUp:
			if s.creating {
				s.focus = 1 - s.focus
			}
			return s, nil
		case tea.KeyEnter:
			if s.a.empty() {
				return s, nil
			}
			if s.creating {
				if s.focus == 0 {
					s.focus = 1
					return s, nil
				}
				if s.a.text() != s.b.text() {
					s.err = "The two passphrases differ. Type them again."
					s.a.clear()
					s.b.clear()
					s.focus = 0
					return s, nil
				}
			}
			s.working, s.err = true, ""
			pass, sh := s.a.text(), s.sh
			return s, func() tea.Msg { return unlockResultMsg{sh.be.Store().Unlock(pass)} }
		}
		if s.focus == 0 {
			s.a.handle(m)
		} else {
			s.b.handle(m)
		}
	}
	return s, nil
}

func (s *unlockScreen) view(w, h int) frame {
	title := "Unlock the vault"
	intro := "Your remembered passwords and tokens are kept in one encrypted file."
	if s.creating {
		title = "Create the vault"
		intro = "Passwords and tokens you remember will be kept in one encrypted file. Choose its passphrase."
	}
	f := frame{title: title, help: "enter continue · esc go on without remembered values"}
	lines := []string{"", "  " + fit(intro, w-4),
		"  " + dimStyle.Render("The passphrase is asked once and kept in memory only until you quit."), ""}
	lines = append(lines, "  "+pad("Passphrase", 14)+s.a.view(w-24, s.focus == 0))
	if s.creating {
		lines = append(lines, "  "+pad("Once more", 14)+s.b.view(w-24, s.focus == 1))
	}
	if s.working {
		lines = append(lines, "", "  "+dimStyle.Render("opening…"))
	}
	if s.err != "" {
		lines = append(lines, "", "  "+errTxtStyle.Render(fit(s.err, w-4)))
	}
	f.body = lines
	return f
}
