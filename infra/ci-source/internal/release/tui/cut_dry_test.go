package tui

import (
	"testing"

	tea "github.com/charmbracelet/bubbletea"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
)

// A dry run cannot be resumed, so `r` with the dry run on must not start a resume.
func TestCutResumeKeyRefusedWhileDry(t *testing.T) {
	s := &cutScreen{phase: cpSetup, dry: true, un: []publish.State{{Unit: "luna", Channel: "beta", Version: "0.4.0-beta.1"}}}
	s.setupKey(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'r'}})
	if s.resume != nil || s.req.Resume || s.phase != cpSetup || s.notice == "" {
		t.Fatalf("resume started during a dry run: %+v", s)
	}
}
