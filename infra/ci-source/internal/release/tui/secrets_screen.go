package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
)

type secretsListMsg struct {
	sts []secrets.Status
	at  time.Time
}

var usedBy = map[secrets.ID]string{
	secrets.LibreServSigning: "sol, sol-connect",
	secrets.LunaSigning:      "luna*",
	secrets.ForgejoToken:     "every cut",
	secrets.AndroidKeystore:  "luna-android",
}

var mustMatch = map[secrets.ID]string{
	secrets.LibreServSigning: "must match keys/libreserv.minisign.pub",
	secrets.LunaSigning:      "must match keys/lsluna.minisign.pub",
	secrets.ForgejoToken:     "the forge must accept it",
	secrets.AndroidKeystore:  "must open and hold the pinned certificate",
}

func pill(s secrets.State) string {
	switch s {
	case secrets.Proven:
		return okStyle.Render("✓ ready")
	case secrets.Failed:
		return failStyle.Render("✗ failed")
	case secrets.Conflict:
		return warnStyle.Render("! conflict")
	}
	return failStyle.Render("· missing")
}

type secretsScreen struct {
	sh      *shared
	sts     []secrets.Status
	at      time.Time
	loading bool
	cur     int
	detail  bool
	dcur    int
	fx      *fixer
	input   *field // add path
	note    string
}

func newSecretsScreen(sh *shared) *secretsScreen { return &secretsScreen{sh: sh} }

func (s *secretsScreen) busy() string { return "" }
func (s *secretsScreen) stop()        {}

func (s *secretsScreen) init() tea.Cmd { return s.load(false, false) }

// load proves everything. asking lets the manager ask for missing passwords.
func (s *secretsScreen) load(asking, full bool) tea.Cmd {
	s.loading = true
	sh := s.sh
	return func() tea.Msg {
		sh.br.SetAsk(asking)
		defer sh.br.SetAsk(false)
		m := sh.be.Secrets()
		if asking || full {
			var out []secrets.Status
			for _, id := range secrets.AllIDs() {
				out = append(out, m.Reprove(context.Background(), id, full))
			}
			return secretsListMsg{out, sh.now()}
		}
		return secretsListMsg{m.List(context.Background()), sh.now()}
	}
}

func (s *secretsScreen) update(msg tea.Msg) (screen, tea.Cmd) {
	switch m := msg.(type) {
	case secretsListMsg:
		s.sts, s.at, s.loading = m.sts, m.at, false
		s.cur = min(s.cur, max(len(s.sts)-1, 0))
		return s, nil
	case fixedMsg:
		s.fx = nil
		s.note = m.note
		return s, s.load(false, false)
	}
	if s.fx != nil {
		done, cmd := s.fx.update(msg)
		if done {
			s.fx = nil
		}
		return s, cmd
	}
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return s, nil
	}
	if s.input != nil {
		switch k.Type {
		case tea.KeyEsc:
			s.input = nil
		case tea.KeyEnter:
			p := strings.TrimSpace(s.input.text())
			s.input = nil
			if p != "" {
				be := s.sh.be.Secrets()
				if err := be.AddPath(p); err != nil {
					s.note = s.sh.redact(err.Error())
					return s, nil
				}
				s.note = "Added " + p
				return s, s.load(false, false)
			}
		default:
			s.input.handle(k)
		}
		return s, nil
	}
	s.note = ""
	if len(s.sts) == 0 && !s.loading {
		if k.String() == "esc" {
			return s, pop()
		}
		return s, nil
	}
	if s.detail {
		return s.detailKey(k)
	}
	switch k.String() {
	case "esc", "q":
		return s, pop()
	case "up", "k":
		s.cur = max(s.cur-1, 0)
	case "down", "j":
		s.cur = min(s.cur+1, len(s.sts)-1)
	case "enter", "right", "l":
		if len(s.sts) > 0 {
			s.detail, s.dcur = true, 0
		}
	case "a":
		s.input = newField("", false)
		s.input.hint = "~/keys or /path/to/file"
	case "t":
		return s, s.load(true, false)
	case "r":
		return s, s.load(true, true)
	case "s":
		return s, push(newStoreScreen(s.sh))
	case "p":
		return s, push(newProtonScreen(s.sh))
	}
	return s, nil
}

func (s *secretsScreen) detailKey(k tea.KeyMsg) (screen, tea.Cmd) {
	st := s.sts[s.cur]
	switch k.String() {
	case "esc", "q", "left", "h":
		s.detail = false
	case "up", "k":
		s.dcur = max(s.dcur-1, 0)
	case "down", "j":
		s.dcur = min(s.dcur+1, max(len(st.Candidates)-1, 0))
	case "e":
		s.fx = newFixer(s.sh, st)
	case "a":
		s.fx = newFixer(s.sh, st)
		for _, it := range s.fx.items {
			if it.kind == "addpath" {
				s.fx.choose(it)
			}
		}
	case "d":
		s.fx = newFixer(s.sh, st)
		for _, it := range s.fx.items {
			if it.kind == "removepath" {
				s.fx.choose(it)
			}
		}
	case "f":
		s.fx = newFixer(s.sh, st)
		for _, it := range s.fx.items {
			if it.kind == "forget" {
				s.fx.choose(it)
			}
		}
	case "c":
		if len(st.Candidates) > 0 {
			c := st.Candidates[s.dcur]
			if c.Outcome == secrets.Valid || c.Outcome == secrets.Used {
				sh, id, ref := s.sh, st.ID, c.Ref
				return s, func() tea.Msg {
					if err := sh.be.Secrets().Choose(id, ref); err != nil {
						return secretsListMsg{sts: s.sts, at: s.at}
					}
					return fixedMsg{id: id, note: "Chosen: " + c.Where}
				}
			}
			s.note = "Only a candidate that proved itself can be chosen."
		}
	case "r":
		return s, s.load(true, false)
	}
	return s, nil
}

func (s *secretsScreen) view(w, h int) frame {
	if s.fx != nil {
		return frame{title: s.sts[s.cur].Label, help: s.fx.help(), body: s.fx.view(w, h)}
	}
	if s.detail && len(s.sts) > 0 {
		return s.detailView(w, h)
	}
	f := frame{title: "Secrets", info: s.storeInfo(),
		help: "enter details · a add file/folder · t test all · r rescan · s store · p Proton Pass · esc"}
	var lines []string
	lines = append(lines, dimStyle.Render("   "+pad("Secret", 26)+pad("State", 12)+pad("From", 28)+"Used by"))
	for i, st := range s.sts {
		name := pad(st.Label, 24)
		if i == s.cur {
			name = selStyle.Render(name)
		}
		lines = append(lines, marker(i == s.cur)+name+"  "+pad(pill(st.State), 12)+pad(from(st), 28)+usedBy[st.ID])
	}
	if s.loading {
		lines = append(lines, "", dimStyle.Render("   Checking… (this proves each secret for real, so it can take a moment)"))
	}
	if len(s.sts) > 0 && s.cur < len(s.sts) {
		lines = append(lines, "", "  "+dimStyle.Render(fit(s.sh.redact(s.sts[s.cur].Summary), w-4)))
	}
	if paths := s.sh.be.Secrets().Paths(); len(paths) > 0 {
		lines = append(lines, "", "  "+dimStyle.Render("Also searching: "+fit(strings.Join(paths, ", "), w-22)))
	}
	if s.input != nil {
		lines = append(lines, "", "  Add a file or folder to search  "+s.input.view(w-40, true))
		f.help = "enter add · esc cancel"
	}
	if s.note != "" {
		lines = append(lines, "", "  "+warnStyle.Render(fit(s.note, w-4)))
	}
	f.body = lines
	return f
}

func from(st secrets.Status) string {
	for _, c := range st.Candidates {
		if c.Outcome == secrets.Used {
			return strings.TrimPrefix(c.Where, "file ")
		}
	}
	switch st.State {
	case secrets.Missing:
		return fmt.Sprintf("searched %s", plural(len(st.Candidates), "place", "places"))
	}
	return ""
}

func (s *secretsScreen) storeInfo() string {
	st := s.sh.be.Store()
	if st == nil {
		return "nothing is remembered"
	}
	return "remembered in: " + storeSummary(st)
}

func (s *secretsScreen) detailView(w, h int) frame {
	st := s.sts[s.cur]
	f := frame{title: st.Label, info: mustMatch[st.ID],
		help: "e enter or paste · a add path · d remove path · c choose · f forget · r prove again · esc"}
	var lines []string
	for i, c := range st.Candidates {
		g := map[secrets.Outcome]string{secrets.Used: okStyle.Render("✓"), secrets.Valid: okStyle.Render("✓"),
			secrets.Rejected: failStyle.Render("✗"), secrets.Unusable: warnStyle.Render("?")}[c.Outcome]
		note := c.Reason
		if c.Detail != "" {
			if note != "" {
				note = c.Detail + " · " + note
			} else {
				note = c.Detail
			}
		}
		if c.Outcome == secrets.Used {
			note += "  used"
		}
		where := pad(c.Where, 36)
		if i == s.dcur {
			where = selStyle.Render(where)
		}
		lines = append(lines, marker(i == s.dcur)+g+" "+where+fit(note, w-42))
	}
	if len(lines) == 0 {
		lines = append(lines, dimStyle.Render("   Nothing was found. Paste it with e, or add the place it lives with a."))
	}
	lines = append(lines, "", "  "+fit(s.sh.redact(st.Summary), w-4))
	if !s.at.IsZero() {
		lines = append(lines, "  "+dimStyle.Render("Checked "+s.at.Format("2006-01-02 15:04")+" · proven by signing or logging in for real"))
	}
	if s.note != "" {
		lines = append(lines, "  "+warnStyle.Render(fit(s.note, w-4)))
	}
	f.body = lines
	return f
}

// ---- store

type storeResultMsg struct {
	note string
	err  error
}

type storeScreen struct {
	sh      *shared
	cur     int // 0 system, 1 vault
	mode    string
	fa      *field
	fb      *field
	fc      *field
	focus   int
	err     string
	note    string
	working bool
}

func newStoreScreen(sh *shared) *storeScreen { return &storeScreen{sh: sh} }
func (s *storeScreen) init() tea.Cmd         { return nil }
func (s *storeScreen) busy() string          { return "" }
func (s *storeScreen) stop()                 {}

func (s *storeScreen) update(msg tea.Msg) (screen, tea.Cmd) {
	st := s.sh.be.Store()
	switch m := msg.(type) {
	case storeResultMsg:
		s.working, s.mode = false, ""
		if m.err != nil {
			s.err = s.sh.redact(m.err.Error())
		} else {
			s.err, s.note = "", m.note
		}
		return s, nil
	case tea.KeyMsg:
		if st == nil || s.working {
			if m.String() == "esc" {
				return s, pop()
			}
			return s, nil
		}
		if s.mode != "" {
			return s.formKey(m, st)
		}
		s.note = ""
		switch m.String() {
		case "esc", "q":
			return s, pop()
		case "up", "k":
			s.cur = 0
		case "down", "j":
			s.cur = 1
		case "enter":
			return s.beginSwitch(st)
		case "u":
			if st.NeedsUnlock() {
				return s, push(newUnlock(s.sh, nil))
			}
		case "p":
			if st.Mode() != secrets.ModeVault || !st.Unlocked() {
				s.err = "Switch to the vault and unlock it first."
				return s, nil
			}
			s.mode, s.fa, s.fb, s.fc, s.focus, s.err = "change", newField("", true), newField("", true), newField("", true), 0, ""
		}
	}
	return s, nil
}

func (s *storeScreen) target() secrets.StoreMode {
	if s.cur == 0 {
		return secrets.ModeSystem
	}
	return secrets.ModeVault
}

func (s *storeScreen) beginSwitch(st StoreAPI) (screen, tea.Cmd) {
	to := s.target()
	s.err = ""
	if to == st.Mode() && st.Saved() == to {
		s.note = "Already using this."
		return s, nil
	}
	vaultOpen := st.Mode() == secrets.ModeVault && st.Unlocked()
	needPass := (to == secrets.ModeVault || st.Mode() == secrets.ModeVault) && !vaultOpen
	if needPass {
		s.mode = "switch"
		s.fa, s.fb, s.focus = newField("", true), newField("", true), 0
		return s, nil
	}
	return s, s.doSwitch(st, to, "")
}

func (s *storeScreen) doSwitch(st StoreAPI, to secrets.StoreMode, pass string) tea.Cmd {
	s.working = true
	return func() tea.Msg {
		n, err := st.SwitchTo(to, pass)
		if err != nil {
			return storeResultMsg{err: err}
		}
		return storeResultMsg{note: fmt.Sprintf("Now using the %s. Moved %s.", to, plural(n, "value", "values"))}
	}
}

func (s *storeScreen) formKey(k tea.KeyMsg, st StoreAPI) (screen, tea.Cmd) {
	fields := []*field{s.fa}
	creating := s.mode == "switch" && !st.VaultExists() && s.target() == secrets.ModeVault
	switch {
	case s.mode == "change":
		fields = []*field{s.fa, s.fb, s.fc}
	case creating:
		fields = []*field{s.fa, s.fb}
	}
	switch k.Type {
	case tea.KeyEsc:
		s.mode, s.err = "", ""
		return s, nil
	case tea.KeyTab, tea.KeyDown:
		s.focus = (s.focus + 1) % len(fields)
		return s, nil
	case tea.KeyUp:
		s.focus = (s.focus + len(fields) - 1) % len(fields)
		return s, nil
	case tea.KeyEnter:
		if s.focus < len(fields)-1 {
			s.focus++
			return s, nil
		}
		switch {
		case s.mode == "change":
			if s.fb.text() != s.fc.text() || s.fb.empty() {
				s.err = "The new passphrase and its repeat differ."
				return s, nil
			}
			old, nw := s.fa.text(), s.fb.text()
			s.working, s.mode = true, ""
			return s, func() tea.Msg {
				if err := st.ChangePassphrase(old, nw); err != nil {
					return storeResultMsg{err: err}
				}
				return storeResultMsg{note: "Vault passphrase changed."}
			}
		default:
			if s.fa.empty() || (creating && s.fa.text() != s.fb.text()) {
				s.err = "The two passphrases differ."
				return s, nil
			}
			pass := s.fa.text()
			s.mode = ""
			return s, s.doSwitch(st, s.target(), pass)
		}
	}
	fields[s.focus].handle(k)
	return s, nil
}

func (s *storeScreen) view(w, h int) frame {
	f := frame{title: "Where remembered values live", help: "↑↓ choose · enter switch · u unlock · p change passphrase · esc back"}
	st := s.sh.be.Store()
	if st == nil {
		f.body = []string{"", "  Remembering values is not available in this session."}
		return f
	}
	sysOK, sysErr := st.SystemAvailable()
	active := func(m secrets.StoreMode) string {
		if st.Mode() == m {
			return okStyle.Render("  ← in use")
		}
		return ""
	}
	sys := "available (" + st.Backend() + ")"
	if !sysOK {
		sys = "not available here"
		_ = sysErr
	}
	vault := "no vault yet; created with your passphrase"
	if st.VaultExists() {
		vault = "locked"
		if st.Unlocked() && st.Mode() == secrets.ModeVault {
			vault = "unlocked"
		}
	}
	lines := []string{"",
		marker(s.cur == 0) + pad("System keyring", 18) + pad(sys, 36) + active(secrets.ModeSystem),
		"    " + dimStyle.Render("Opens with your desktop login. Nothing to type."),
		marker(s.cur == 1) + pad("Passphrase vault", 18) + pad(vault, 36) + active(secrets.ModeVault),
		"    " + dimStyle.Render("One encrypted file, one passphrase, asked once per session."),
		"    " + dimStyle.Render(fit(st.VaultDir(), w-8)),
		"", "  " + dimStyle.Render("Switching copies every remembered value to the new place, checks it, then removes the old copy.")}
	if st.Saved() == "" {
		lines = append(lines, "  "+dimStyle.Render("No choice saved yet: using the default (system keyring when there is one)."))
	}
	switch s.mode {
	case "switch":
		lines = append(lines, "", "  "+panelStyle.Render("Vault passphrase")+"  "+s.fa.view(w-30, s.focus == 0))
		if !st.VaultExists() && s.target() == secrets.ModeVault {
			lines = append(lines, "  "+panelStyle.Render("Once more       ")+"  "+s.fb.view(w-30, s.focus == 1))
		}
		f.help = "enter go on · tab next · esc cancel"
	case "change":
		lines = append(lines, "",
			"  "+pad("Current passphrase", 20)+s.fa.view(w-30, s.focus == 0),
			"  "+pad("New passphrase", 20)+s.fb.view(w-30, s.focus == 1),
			"  "+pad("New, once more", 20)+s.fc.view(w-30, s.focus == 2))
		f.help = "enter go on · tab next · esc cancel"
	}
	if s.working {
		lines = append(lines, "", "  "+dimStyle.Render("working…"))
	}
	if s.note != "" {
		lines = append(lines, "", "  "+okStyle.Render("✓ ")+s.note)
	}
	if s.err != "" {
		lines = append(lines, "", "  "+errTxtStyle.Render(fit(s.err, w-4)))
	}
	f.body = lines
	return f
}

// ---- Proton Pass

type protonScreen struct {
	sh   *shared
	cfg  secrets.ProtonConfig
	cur  int
	edit *field
	err  string
}

func newProtonScreen(sh *shared) *protonScreen {
	s := &protonScreen{sh: sh, cfg: sh.be.Secrets().ProtonConfig()}
	if s.cfg.Refs == nil {
		s.cfg.Refs = map[string]string{}
	}
	return s
}

func (s *protonScreen) init() tea.Cmd { return nil }
func (s *protonScreen) busy() string  { return "" }
func (s *protonScreen) stop()         {}

func (s *protonScreen) slots() []secrets.SlotInfo { return s.sh.be.Secrets().Slots() }

func (s *protonScreen) save() {
	if err := s.sh.be.Secrets().SetProton(s.cfg); err != nil {
		s.err = s.sh.redact(err.Error())
	} else {
		s.err = ""
	}
}

func (s *protonScreen) update(msg tea.Msg) (screen, tea.Cmd) {
	k, ok := msg.(tea.KeyMsg)
	if !ok {
		return s, nil
	}
	sl := s.slots()
	if s.edit != nil {
		switch k.Type {
		case tea.KeyEsc:
			s.edit = nil
		case tea.KeyEnter:
			ref := strings.TrimSpace(s.edit.text())
			slot := sl[s.cur-1].Slot
			if ref == "" {
				delete(s.cfg.Refs, slot)
			} else {
				s.cfg.Refs[slot] = ref
			}
			s.edit = nil
			s.save()
		default:
			s.edit.handle(k)
		}
		return s, nil
	}
	switch k.String() {
	case "esc", "q":
		return s, pop()
	case "up", "k":
		s.cur = max(s.cur-1, 0)
	case "down", "j":
		s.cur = min(s.cur+1, len(sl))
	case " ", "enter":
		if s.cur == 0 {
			s.cfg.Enabled = !s.cfg.Enabled
			s.save()
		} else {
			s.edit = newField(s.cfg.Refs[sl[s.cur-1].Slot], false)
			s.edit.hint = "pass://Vault/Item/field"
		}
	}
	return s, nil
}

func (s *protonScreen) view(w, h int) frame {
	f := frame{title: "Proton Pass", help: "↑↓ move · space/enter change · esc back"}
	lines := []string{"", marker(s.cur == 0) + checkbox(s.cfg.Enabled) + " Read secrets from Proton Pass " +
		dimStyle.Render("(needs pass-cli signed in)"), "", "  " + dimStyle.Render("Where each value lives (a pass:// reference); empty means not used")}
	for i, sl := range s.slots() {
		ref := s.cfg.Refs[sl.Slot]
		val := dimStyle.Render("not set")
		if ref != "" {
			val = ref
		}
		if s.edit != nil && s.cur == i+1 {
			val = s.edit.view(w-40, true)
		}
		lines = append(lines, marker(s.cur == i+1)+pad(sl.Label, 36)+val)
	}
	if s.err != "" {
		lines = append(lines, "", "  "+errTxtStyle.Render(fit(s.err, w-4)))
	}
	f.body = window(lines, s.cur+4, h)
	return f
}
