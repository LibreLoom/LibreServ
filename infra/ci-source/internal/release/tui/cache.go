package tui

import (
	tea "github.com/charmbracelet/bubbletea"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
)

// storeSnap is what the screens know about where remembered values live. The
// store can be slow (a locked keyring answers after seconds), so screens read
// this copy; cacheCmd refreshes it off the update loop.
type storeSnap struct {
	loaded      bool
	have        bool // remembering values is available at all
	mode, saved secrets.StoreMode
	unlocked    bool
	needsUnlock bool
	sysOK       bool
	backend     string
	vaultExists bool
	vaultDir    string
}

// cacheMsg carries a fresh snapshot of everything a screen may show from the
// store or the keyring.
type cacheMsg struct {
	seq   int
	snap  storeSnap
	slots []secrets.SlotInfo
	paths []string
}

func readSnap(be Backend) storeSnap {
	st := be.Store()
	if st == nil {
		return storeSnap{loaded: true}
	}
	s := storeSnap{loaded: true, have: true, mode: st.Mode(), saved: st.Saved(),
		unlocked: st.Unlocked(), needsUnlock: st.NeedsUnlock(),
		vaultExists: st.VaultExists(), vaultDir: st.VaultDir()}
	s.sysOK, _ = st.SystemAvailable()
	if s.mode == secrets.ModeVault || s.sysOK {
		s.backend = st.Backend()
	}
	return s
}

// cacheCmd reads the store state, the remembered slots and the added paths.
// Newer reads win over older ones that arrive late.
func cacheCmd(sh *shared) tea.Cmd {
	sh.cacheSeq++
	seq, be := sh.cacheSeq, sh.be
	return func() tea.Msg {
		m := cacheMsg{seq: seq, snap: readSnap(be)}
		m.slots = be.Secrets().Slots()
		m.paths = be.Secrets().Paths()
		return m
	}
}

// storeSummary says where remembered values live and whether they can be read.
func storeSummary(s storeSnap) string {
	if !s.loaded {
		return "checking…"
	}
	if s.mode == secrets.ModeVault {
		if s.unlocked {
			return "passphrase vault, unlocked"
		}
		return "passphrase vault, locked"
	}
	if !s.sysOK {
		return "system keyring not reachable"
	}
	return "system keyring (" + s.backend + ")"
}
