package tui

import (
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
)

type (
	homeLoadedMsg struct {
		repo       app.RepoStatus
		units      []app.UnitStatus
		unfinished map[string][]publish.State
	}
	feedsMsg   struct{ heads []app.FeedHead }
	healthMsg  struct{ rep *app.DoctorReport }
	secretsMsg struct{ sts []secrets.Status }
)

type home struct {
	sh         *shared
	repo       app.RepoStatus
	loaded     bool
	units      []app.UnitStatus
	unfinished map[string][]publish.State
	feeds      map[string]map[string]app.FeedHead // unit -> channel
	health     *app.DoctorReport
	secrets    []secrets.Status
	secretsOK  bool // checked
	cur        int
	notice     string
}

func newHome(sh *shared) *home {
	return &home{sh: sh, feeds: map[string]map[string]app.FeedHead{}}
}

func (h *home) busy() string { return "" }
func (h *home) stop()        {}

func (h *home) init() tea.Cmd {
	sh := h.sh
	load := func() tea.Msg {
		m := homeLoadedMsg{repo: sh.be.RepoStatus(sh.ctx), units: sh.be.UnitStatuses(sh.ctx), unfinished: map[string][]publish.State{}}
		for _, u := range m.units {
			if st, err := sh.be.Unfinished(u.Unit); err == nil && len(st) > 0 {
				m.unfinished[u.Unit] = st
			}
		}
		return m
	}
	health := func() tea.Msg { return healthMsg{sh.be.Doctor(sh.ctx, false)} }
	return tea.Batch(load, health)
}

func (h *home) checkSecrets() tea.Cmd {
	sh := h.sh
	return func() tea.Msg {
		sh.br.SetAsk(false)
		return secretsMsg{sh.be.Secrets().List(sh.ctx)}
	}
}

func (h *home) selected() string {
	if h.cur < len(h.units) {
		return h.units[h.cur].Unit
	}
	return ""
}

func (h *home) update(msg tea.Msg) (screen, tea.Cmd) {
	sh := h.sh
	switch m := msg.(type) {
	case homeLoadedMsg:
		h.repo, h.units, h.unfinished, h.loaded = m.repo, m.units, m.unfinished, true
		var cmds []tea.Cmd
		for _, u := range m.units {
			unit := u.Unit
			cmds = append(cmds, func() tea.Msg { return feedsMsg{sh.be.FeedHeads(sh.ctx, unit)} })
		}
		return h, tea.Batch(cmds...)
	case feedsMsg:
		for _, f := range m.heads {
			if h.feeds[f.Unit] == nil {
				h.feeds[f.Unit] = map[string]app.FeedHead{}
			}
			h.feeds[f.Unit][f.Channel] = f
		}
	case healthMsg:
		h.health = m.rep
	case storeReadyMsg:
		return h, h.checkSecrets()
	case secretsMsg:
		h.secrets, h.secretsOK = m.sts, true
	case tea.KeyMsg:
		h.notice = ""
		switch m.String() {
		case "up", "k":
			h.cur = max(h.cur-1, 0)
		case "down", "j":
			h.cur = min(h.cur+1, max(len(h.units)-1, 0))
		case "q":
			return h, tea.Quit
		case "b":
			return h, push(newBuild(sh, h.selected()))
		case "c":
			return h, push(newCut(sh, h.selected(), nil))
		case "r":
			un := h.unfinished[h.selected()]
			if len(un) == 0 {
				h.notice = "Nothing to resume for " + h.selected() + "."
				return h, nil
			}
			st := un[0]
			return h, push(newCut(sh, h.selected(), &st))
		case "v":
			return h, push(newVerify(sh, h.selected()))
		case "u":
			return h, push(newServe(sh))
		case "s":
			return h, push(newSecretsScreen(sh))
		case "d":
			return h, push(newDoctor(sh))
		case "R":
			h.secretsOK = false
			h.health = nil
			h.feeds = map[string]map[string]app.FeedHead{}
			return h, tea.Batch(h.init(), h.checkSecrets())
		case "?":
			return h, push(newHelp())
		}
	}
	return h, nil
}

func (h *home) feedCell(unit, ch string, w int) string {
	f, ok := h.feeds[unit][ch]
	switch {
	case !ok:
		return pad(dimStyle.Render("…"), w)
	case f.Missing:
		return pad(dimStyle.Render("—"), w)
	case f.Err != "":
		return pad(failStyle.Render("✗ ")+"feed problem", w)
	}
	age := ago(f.Published, h.sh.now())
	return pad(fmt.Sprintf("%-13s %3s", fit(f.Version, 13), age), w)
}

func (h *home) view(w, bodyH int) frame {
	f := frame{title: "LibreServ release"}
	switch {
	case h.repo.Err != "":
		f.info = fit(h.repo.Err, w/2)
	case h.loaded:
		state := "clean"
		if !h.repo.Clean {
			state = "changes not committed"
		}
		f.info = fmt.Sprintf("%s · %s · %s", h.repo.Branch, h.repo.SHA, state)
	default:
		f.info = "looking at the checkout…"
	}
	f.help = "b build · c cut · v verify · u serve-dev · s secrets · d doctor · ? help · q quit"

	var lines []string
	lines = append(lines, dimStyle.Render("  "+pad("Unit", 13)+pad("Version", 14)+pad("Since tag", 12)+pad("Stable", 18)+"Beta"))
	for i, u := range h.units {
		since := "no tag"
		switch {
		case u.Since >= 0 && u.LastTag != "":
			since = plural(u.Since, "commit", "commits")
		case u.Since >= 0:
			since = "never tagged"
		}
		name := pad(u.Unit, 13)
		if i == h.cur {
			name = selStyle.Render(name)
		}
		row := marker(i == h.cur) + name + pad(orDash(u.Version), 14) + pad(since, 12) +
			h.feedCell(u.Unit, "stable", 18) + h.feedCell(u.Unit, "beta", 18)
		if u.Err != "" {
			row = marker(i == h.cur) + name + errTxtStyle.Render(fit(u.Err, w-18))
		}
		lines = append(lines, row)
	}
	if !h.loaded {
		lines = append(lines, dimStyle.Render("   loading…"))
	}
	lines = append(lines, "")
	// Unfinished cuts.
	var un []string
	for _, u := range h.units {
		for _, st := range h.unfinished[u.Unit] {
			stopped := "just started"
			for _, s := range publish.Steps {
				if !st.Done[s] {
					stopped = "stopped before " + s
					break
				}
			}
			un = append(un, fmt.Sprintf("   %s %s (%s) %s", u.Unit, st.Version, st.Channel, stopped))
		}
	}
	if len(un) > 0 {
		lines = append(lines, warnStyle.Render("   Unfinished cuts")+dimStyle.Render("   r resumes the one for the selected unit"))
		lines = append(lines, un...)
		lines = append(lines, "")
	}
	lines = append(lines, h.secretsLine(w), h.podmanLine(w), h.storeLine(w))
	if h.notice != "" {
		lines = append(lines, "", "   "+warnStyle.Render(h.notice))
	}
	f.body = lines
	return f
}

func orDash(s string) string {
	if s == "" {
		return "—"
	}
	return s
}

func (h *home) secretsLine(w int) string {
	label := pad("   Secrets", 13)
	if !h.secretsOK {
		return label + dimStyle.Render("checking…")
	}
	ok := 0
	var bad []string
	for _, s := range h.secrets {
		if s.State == secrets.Proven {
			ok++
		} else {
			bad = append(bad, strings.TrimSuffix(strings.ToLower(s.Label[:1])+s.Label[1:], " key"))
		}
	}
	text := fmt.Sprintf("%d/%d ready", ok, len(h.secrets))
	if len(bad) > 0 {
		text += " · not ready: " + strings.Join(bad, ", ") + "   " + dimStyle.Render("s to fix")
		return label + warnStyle.Render("! ") + fit(text, w-16)
	}
	return label + okStyle.Render("✓ ") + text
}

func (h *home) podmanLine(w int) string {
	label := pad("   Podman", 13)
	r := h.health
	if r == nil {
		return label + dimStyle.Render("checking…")
	}
	if !r.PodmanOK {
		return label + failStyle.Render("✗ ") + "not working; d shows why"
	}
	root := "rootless"
	if !r.Rootless {
		root = "NOT rootless"
	}
	return label + fit(fmt.Sprintf("%s %s · images %d/%d current · %.0f GB free", r.PodmanVersion, root, r.ImagesCurrent, r.ImagesTotal, r.FreeGB), w-14)
}

func (h *home) storeLine(w int) string {
	label := pad("   Stored in", 13)
	st := h.sh.be.Store()
	if st == nil {
		return label + dimStyle.Render("values cannot be remembered here")
	}
	return label + fit(storeSummary(st), w-14) + "   " + dimStyle.Render("s › t to change")
}

// storeSummary says where remembered values live and whether they can be read.
func storeSummary(st StoreAPI) string {
	if st.Mode() == secrets.ModeVault {
		if st.Unlocked() {
			return "passphrase vault, unlocked"
		}
		return "passphrase vault, locked"
	}
	if ok, _ := st.SystemAvailable(); !ok {
		return "system keyring not reachable"
	}
	return "system keyring (" + st.Backend() + ")"
}

// ---- help

type helpScreen struct{}

func newHelp() screen             { return &helpScreen{} }
func (*helpScreen) init() tea.Cmd { return nil }
func (*helpScreen) busy() string  { return "" }
func (*helpScreen) stop()         {}
func (s *helpScreen) update(msg tea.Msg) (screen, tea.Cmd) {
	if k, ok := msg.(tea.KeyMsg); ok {
		switch k.String() {
		case "esc", "q", "?", "enter":
			return s, pop()
		}
	}
	return s, nil
}
func (*helpScreen) view(w, h int) frame {
	return frame{title: "Help", help: "esc back", body: []string{
		"  Home       ↑↓ choose a unit · b build · c cut · r resume a stopped cut",
		"             v verify a published feed · u serve-dev · s secrets · d doctor",
		"             R check everything again · q quit",
		"",
		"  Everywhere esc goes back. Ctrl-C asks before stopping a build or a cut.",
		"",
		"  Build      builds from a git ref into dist/. It never needs a release",
		"             secret and never publishes.",
		"  Cut        bump, build, sign, upload, verify, feed, mirror, tag. If it",
		"             stops, it can be resumed: nothing is done twice.",
		"  Secrets    found and proven by their contents. Values are never shown.",
		"",
		"  The same things work without the TUI: release build | cut | verify |",
		"  serve-dev | secrets | doctor (see release help).",
	}}
}

var _ = time.Second
