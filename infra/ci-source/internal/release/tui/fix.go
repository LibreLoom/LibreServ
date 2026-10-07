package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
)

// fixer is the "what can I do about this secret" panel. The preflight screen
// and the secrets screen both use it.
type fixer struct {
	sh    *shared
	st    secrets.Status
	stage int
	items []fixItem
	cur   int
	f     *field

	act         fixItem
	remember    bool
	canRemember bool
	err         string
	busy        bool
}

const (
	fxMenu = iota
	fxInput
	fxPick // choose among items (candidates, paths, slots)
)

type fixItem struct {
	label string
	kind  string // password, value, key, keystore, addpath, removepath, choose, clearchoice, forget, reprove, fullreprove
	slot  string
	ref   string // candidate ref or path
	hint  string
}

// fixedMsg tells the screen that something changed and the secret should be
// checked again.
type fixedMsg struct {
	id   secrets.ID
	note string
}

type fixResultMsg struct {
	id   secrets.ID
	err  error
	note string
}

func newFixer(sh *shared, st secrets.Status) *fixer {
	x := &fixer{sh: sh, st: st, f: newField("", true)}
	if s := sh.be.Store(); s != nil && s.Unlocked() {
		x.canRemember = true
	}
	x.items = x.menu()
	return x
}

// menu lists what applies to this secret.
func (x *fixer) menu() []fixItem {
	be := x.sh.be.Secrets()
	var it []fixItem
	switch x.st.ID {
	case secrets.LibreServSigning, secrets.LunaSigning:
		it = append(it,
			fixItem{label: "Enter the key's password", kind: "password", slot: secrets.SlotPassword(x.st.ID),
				hint: "The password you chose when you created this signing key."},
			fixItem{label: "Paste the secret key", kind: "key", slot: secrets.SlotKey(x.st.ID),
				hint: "Paste the whole key file, or just its long line that starts with RW."},
			fixItem{label: "Add a file or folder to search", kind: "addpath"})
	case secrets.ForgejoToken:
		it = append(it, fixItem{label: "Paste an access token", kind: "value", slot: secrets.SlotForgejoToken,
			hint: "Forgejo → Settings → Applications → new token, with write access to repositories and packages."})
	case secrets.AndroidKeystore:
		it = append(it,
			fixItem{label: "Paste the keystore (base64)", kind: "keystore", slot: secrets.SlotAndroidKeystore,
				hint: "The keystore file encoded as base64, on one line or several."},
			fixItem{label: "Enter the store password", kind: "value", slot: secrets.SlotAndroidStorePW,
				hint: "The store password you chose when you created the keystore."},
			fixItem{label: "Enter the key password", kind: "value", slot: secrets.SlotAndroidKeyPW,
				hint: "The key password (often the same as the store password)."},
			fixItem{label: "Enter the key alias", kind: "alias", slot: secrets.SlotAndroidAlias,
				hint: "The name of the key inside the keystore (luna unless you chose another)."},
			fixItem{label: "Add a file or folder to search", kind: "addpath"})
	}
	if len(be.Paths()) > 0 {
		it = append(it, fixItem{label: "Stop searching an added file or folder", kind: "removepath"})
	}
	for _, c := range x.st.Candidates {
		if x.st.State == secrets.Conflict && (c.Outcome == secrets.Valid || c.Outcome == secrets.Used) {
			it = append(it, fixItem{label: "Choose which one to use", kind: "choose"})
			break
		}
	}
	if len(x.rememberedSlots()) > 0 {
		it = append(it, fixItem{label: "Forget a remembered value", kind: "forget"})
	}
	return append(it, fixItem{label: "Check again", kind: "reprove"})
}

// slotsFor lists the slots that belong to this secret.
func slotsFor(id secrets.ID) map[string]bool {
	m := map[string]bool{}
	switch id {
	case secrets.LibreServSigning, secrets.LunaSigning:
		m[secrets.SlotKey(id)], m[secrets.SlotPassword(id)], m[secrets.SlotMinisignPassword] = true, true, true
	case secrets.ForgejoToken:
		m[secrets.SlotForgejoToken] = true
	case secrets.AndroidKeystore:
		for _, s := range []string{secrets.SlotAndroidKeystore, secrets.SlotAndroidStorePW, secrets.SlotAndroidKeyPW, secrets.SlotAndroidAlias} {
			m[s] = true
		}
	}
	return m
}

func (x *fixer) rememberedSlots() []secrets.SlotInfo {
	mine := slotsFor(x.st.ID)
	var out []secrets.SlotInfo
	for _, s := range x.sh.be.Secrets().Slots() {
		if s.Set && mine[s.Slot] {
			out = append(out, s)
		}
	}
	return out
}

func (x *fixer) update(msg tea.Msg) (done bool, cmd tea.Cmd) {
	switch m := msg.(type) {
	case fixResultMsg:
		x.busy = false
		if m.err != nil {
			x.err = x.sh.redact(m.err.Error())
			return false, nil
		}
		return true, send(fixedMsg{m.id, m.note})
	case tea.KeyMsg:
		if x.busy {
			return false, nil
		}
		switch x.stage {
		case fxMenu:
			return x.menuKey(m)
		case fxInput:
			return x.inputKey(m)
		case fxPick:
			return x.pickKey(m)
		}
	}
	return false, nil
}

func (x *fixer) menuKey(k tea.KeyMsg) (bool, tea.Cmd) {
	switch k.String() {
	case "esc":
		return true, nil
	case "up", "k":
		x.cur = max(x.cur-1, 0)
	case "down", "j":
		x.cur = min(x.cur+1, len(x.items)-1)
	case "enter":
		return x.choose(x.items[x.cur])
	}
	return false, nil
}

// choose acts on a menu item.
func (x *fixer) choose(it fixItem) (bool, tea.Cmd) {
	x.err = ""
	x.act = it
	switch it.kind {
	case "reprove":
		return false, x.run(func() (string, error) { return "checked again", nil })
	case "password", "value", "key", "keystore", "alias", "addpath":
		x.stage = fxInput
		x.f = newField("", it.kind != "addpath" && it.kind != "alias")
		x.f.multi = it.kind == "key"
		x.remember = x.canRemember
		if it.kind == "addpath" {
			x.f.hint = "~/keys or /path/to/file"
		}
	case "removepath":
		x.stage, x.cur, x.items = fxPick, 0, nil
		for _, p := range x.sh.be.Secrets().Paths() {
			x.items = append(x.items, fixItem{label: p, kind: "removepath", ref: p})
		}
	case "choose":
		x.stage, x.cur, x.items = fxPick, 0, nil
		for _, c := range x.st.Candidates {
			if c.Outcome == secrets.Valid || c.Outcome == secrets.Used {
				x.items = append(x.items, fixItem{label: c.Where, kind: "choose", ref: c.Ref})
			}
		}
	case "forget":
		x.stage, x.cur, x.items = fxPick, 0, nil
		for _, s := range x.rememberedSlots() {
			x.items = append(x.items, fixItem{label: s.Label, kind: "forget", slot: s.Slot})
		}
	}
	return false, nil
}

func (x *fixer) pickKey(k tea.KeyMsg) (bool, tea.Cmd) {
	switch k.String() {
	case "esc":
		x.stage, x.cur, x.items = fxMenu, 0, x.menu()
	case "up", "k":
		x.cur = max(x.cur-1, 0)
	case "down", "j":
		x.cur = min(x.cur+1, len(x.items)-1)
	case "enter":
		if len(x.items) == 0 {
			return false, nil
		}
		it := x.items[x.cur]
		be := x.sh.be.Secrets()
		switch it.kind {
		case "removepath":
			return false, x.run(func() (string, error) { return "stopped searching " + it.ref, be.RemovePath(it.ref) })
		case "choose":
			id := x.st.ID
			return false, x.run(func() (string, error) { return "chosen", be.Choose(id, it.ref) })
		case "forget":
			return false, x.run(func() (string, error) { return "forgotten", be.Forget(it.slot) })
		}
	}
	return false, nil
}

func (x *fixer) inputKey(k tea.KeyMsg) (bool, tea.Cmd) {
	switch k.Type {
	case tea.KeyEsc:
		x.stage, x.cur, x.items, x.err = fxMenu, 0, x.menu(), ""
		return false, nil
	case tea.KeyTab:
		if x.canRemember {
			x.remember = !x.remember
		}
		return false, nil
	case tea.KeyEnter:
		if x.f.empty() {
			return false, nil
		}
		return false, x.save()
	}
	x.f.handle(k)
	return false, nil
}

// save stores what was typed and has the manager use it. The value never
// leaves this function except into the manager.
func (x *fixer) save() tea.Cmd {
	val, remember, it, id := x.f.text(), x.remember && x.canRemember, x.act, x.st.ID
	be := x.sh.be.Secrets()
	return x.run(func() (string, error) {
		switch it.kind {
		case "addpath":
			return "added " + strings.TrimSpace(val), be.AddPath(strings.TrimSpace(val))
		case "key":
			n, err := be.PasteKey(id, val, remember)
			return fmt.Sprintf("key kept (%d characters)", n), err
		case "keystore":
			n, err := be.PasteKeystore(val, remember)
			return fmt.Sprintf("keystore kept (%s)", humanSize(int64(n))), err
		}
		return "saved", be.SetValueOpt(it.slot, strings.TrimSpace(val), remember)
	})
}

// run does f off the UI thread. Asking questions is off, so nothing here can
// open a second prompt.
func (x *fixer) run(f func() (string, error)) tea.Cmd {
	x.busy = true
	id, sh := x.st.ID, x.sh
	return func() tea.Msg {
		sh.br.SetAsk(false)
		note, err := f()
		return fixResultMsg{id: id, err: err, note: note}
	}
}

func (x *fixer) view(w, h int) []string {
	lines := []string{"  " + panelStyle.Render(x.st.Label) + dimStyle.Render("  what would you like to do?")}
	switch x.stage {
	case fxMenu, fxPick:
		title := ""
		if x.stage == fxPick {
			title = dimStyle.Render("  " + x.act.label)
			lines = append(lines[:0], "  "+panelStyle.Render(x.st.Label), title)
		}
		var rows []string
		for i, it := range x.items {
			rows = append(rows, marker(i == x.cur)+fit(it.label, w-6))
		}
		if len(rows) == 0 {
			rows = append(rows, dimStyle.Render("    nothing to choose from"))
		}
		lines = append(lines, "")
		lines = append(lines, window(rows, x.cur, max(h-len(lines)-2, 1))...)
	case fxInput:
		lines = append(lines, "", "  "+x.act.label)
		if x.act.hint != "" {
			lines = append(lines, "  "+dimStyle.Render(fit(x.act.hint, w-4)))
		}
		store := ""
		if x.canRemember && x.act.kind != "addpath" {
			store = "  " + checkbox(x.remember) + " Remember"
		}
		lines = append(lines, "", "  "+pad(x.f.view(w-24, true), w-24)+store)
	}
	if x.busy {
		lines = append(lines, "", "  "+dimStyle.Render("working…"))
	}
	if x.err != "" {
		lines = append(lines, "", "  "+errTxtStyle.Render(fit(x.err, w-4)))
	}
	return fill(lines, h)
}

func (x *fixer) help() string {
	switch x.stage {
	case fxInput:
		if x.canRemember && x.act.kind != "addpath" {
			return "enter save · tab remember · esc back"
		}
		return "enter save · esc back"
	case fxPick:
		return "↑↓ choose · enter do it · esc back"
	}
	return "↑↓ choose · enter go · esc close"
}
