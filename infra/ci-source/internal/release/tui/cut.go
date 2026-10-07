package tui

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/secrets"
)

const (
	cpSetup = iota
	cpNotes
	cpPreflight
	cpRun
	cpDone
)

var cutPhaseNames = []string{"Version", "Notes", "Preflight", "Run", "Verify"}

type (
	notesMsg     struct{ text, hint string }
	preflightMsg struct{ rep *app.PreflightReport }
	preflightGo  struct{}
	cutDoneMsg   struct {
		res *app.CutResult
		err error
	}
)

type cutScreen struct {
	sh    *shared
	phase int

	// setup
	units     []string
	unitIdx   int
	channel   string
	bumpIdx   int
	previews  []app.BumpPreview
	dry       bool
	rebuild   bool
	notesHint string
	row       int
	un        []publish.State // unfinished cuts of the chosen unit
	resume    *publish.State  // set when resuming
	notice    string

	// notes
	ed     *editor
	loaded bool

	// preflight
	req     app.CutRequest
	rep     *app.PreflightReport
	pfBusy  bool
	pfCur   int
	fx      *fixer
	fixNote string

	// run
	b        *board
	cancel   context.CancelFunc
	started  time.Time
	ended    time.Time
	res      *app.CutResult
	err      error
	stopping bool
	urlOff   int
	version  string
}

func newCut(sh *shared, unit string, resume *publish.State) *cutScreen {
	s := &cutScreen{sh: sh, units: sh.be.Units(), channel: publish.Stable, b: newBoard(sh)}
	for i, u := range s.units {
		if u == unit {
			s.unitIdx = i
		}
	}
	s.refresh()
	if resume != nil {
		s.resume = resume
		s.channel = resume.Channel
		s.phase = cpNotes
		s.req = app.CutRequest{Unit: resume.Unit, Channel: resume.Channel, Version: resume.Version, Resume: true}
		s.version = resume.Version
	}
	return s
}

func (s *cutScreen) unit() string {
	if len(s.units) == 0 {
		return ""
	}
	return s.units[s.unitIdx]
}

func (s *cutScreen) refresh() {
	s.previews = s.sh.be.BumpPreviews(s.unit(), s.channel)
	s.un, _ = s.sh.be.Unfinished(s.unit())
}

func (s *cutScreen) busy() string {
	if s.phase == cpRun && s.cancel != nil {
		return "cut"
	}
	return ""
}

func (s *cutScreen) consumesEsc() bool { return s.b.full }

func (s *cutScreen) stop() {
	if s.cancel != nil {
		s.cancel()
	}
	s.stopping = true
}

func (s *cutScreen) init() tea.Cmd {
	if s.phase == cpNotes {
		return s.loadNotes()
	}
	return nil
}

func (s *cutScreen) loadNotes() tea.Cmd {
	sh, unit := s.sh, s.req.Unit
	if unit == "" {
		unit = s.unit()
	}
	if s.resume != nil && s.resume.Notes != "" {
		saved := s.resume.Notes
		return func() tea.Msg { return notesMsg{text: saved} }
	}
	return func() tea.Msg {
		d, err := sh.be.NotesDraft(sh.ctx, unit)
		if err != nil {
			return notesMsg{}
		}
		return notesMsg{d.Text, d.Hint()}
	}
}

func (s *cutScreen) update(msg tea.Msg) (screen, tea.Cmd) {
	switch m := msg.(type) {
	case notesMsg:
		s.ed, s.loaded, s.notesHint = newEditor(m.text), true, m.hint
		return s, nil
	case preflightGo:
		return s, s.preflight()
	case preflightMsg:
		s.rep, s.pfBusy = m.rep, false
		s.pfCur = 0
		s.moveCur(0)
		return s, nil
	case cutDoneMsg:
		s.cancel = nil
		s.res, s.err, s.ended = m.res, m.err, s.sh.now()
		var pe *app.PreflightError
		if errors.As(m.err, &pe) {
			// The cut's own check disagreed with ours: show it, fixable.
			s.phase, s.rep, s.err = cpPreflight, pe.Report, nil
			s.moveCur(0)
			return s, nil
		}
		s.phase = cpDone
		return s, nil
	case fixedMsg:
		s.fx = nil
		s.fixNote = m.note
		return s, s.preflight()
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
	switch s.phase {
	case cpSetup:
		return s.setupKey(k)
	case cpNotes:
		return s.notesKey(k)
	case cpPreflight:
		return s.preflightKey(k)
	case cpRun:
		s.b.key(k, s.sh.h-4)
	case cpDone:
		return s.doneKey(k)
	}
	return s, nil
}

// ---- setup

func (s *cutScreen) setupKey(k tea.KeyMsg) (screen, tea.Cmd) {
	s.notice = ""
	switch k.String() {
	case "esc", "q":
		return s, pop()
	case "up", "k":
		s.row = max(s.row-1, 0)
	case "down", "j", "tab":
		s.row = min(s.row+1, 4)
	case "left", "h", "right", "l":
		d := 1
		if k.String() == "left" || k.String() == "h" {
			d = -1
		}
		s.change(d)
	case " ":
		switch s.row {
		case 3:
			s.dry = !s.dry
		case 4:
			s.rebuild = !s.rebuild
		}
	case "d":
		s.dry = !s.dry
	case "r":
		if s.dry && len(s.un) > 0 {
			s.notice = "A dry run cannot resume a cut: turn the dry run off first."
			return s, nil
		}
		if len(s.un) > 0 {
			st := s.un[0]
			s.resume = &st
			s.req = app.CutRequest{Unit: st.Unit, Channel: st.Channel, Version: st.Version, Resume: true, Dry: s.dry, Rebuild: s.rebuild}
			s.version = st.Version
			s.phase = cpNotes
			return s, s.loadNotes()
		}
	case "enter":
		p := s.previews[s.bumpIdx]
		if p.Err != "" {
			s.notice = "That bump is not possible: " + p.Err
			return s, nil
		}
		s.req = app.CutRequest{Unit: s.unit(), Channel: s.channel, Bump: p.Kind, Dry: s.dry, Rebuild: s.rebuild}
		s.version = p.Version
		s.phase = cpNotes
		return s, s.loadNotes()
	}
	return s, nil
}

func (s *cutScreen) change(d int) {
	switch s.row {
	case 0:
		s.unitIdx = (s.unitIdx + d + len(s.units)) % len(s.units)
	case 1:
		if s.channel == publish.Stable {
			s.channel = publish.Beta
		} else {
			s.channel = publish.Stable
		}
		s.bumpIdx = 0
		if s.channel == publish.Beta {
			s.bumpIdx = 3
		}
	case 2:
		s.bumpIdx = (s.bumpIdx + d + 4) % 4
	case 3:
		s.dry = !s.dry
	case 4:
		s.rebuild = !s.rebuild
	}
	s.refresh()
}

// ---- notes

func (s *cutScreen) notesKey(k tea.KeyMsg) (screen, tea.Cmd) {
	switch k.String() {
	case "esc":
		if s.resume != nil && s.phase == cpNotes {
			return s, pop()
		}
		s.phase = cpSetup
		return s, nil
	case "ctrl+s", "ctrl+n", "ctrl+d":
		if !s.loaded {
			return s, nil
		}
		s.req.Notes = s.ed.text()
		s.req.Dry = s.dry || s.req.Dry
		return s, s.toPreflight()
	}
	if s.loaded {
		s.ed.handle(k, max(s.sh.h-8, 3))
	}
	return s, nil
}

// toPreflight makes sure the vault is open first: asking for the passphrase
// is allowed here, never after the cut has started.
func (s *cutScreen) toPreflight() tea.Cmd {
	s.phase, s.rep, s.fixNote = cpPreflight, nil, ""
	if s.sh.snap.have && s.sh.snap.needsUnlock {
		return push(newUnlock(s.sh, func() tea.Cmd { return send(preflightGo{}) }))
	}
	return s.preflight()
}

// ---- preflight

func (s *cutScreen) preflight() tea.Cmd {
	s.pfBusy = true
	sh, req := s.sh, s.req
	return func() tea.Msg {
		sh.be.Secrets().Refresh()
		done := sh.br.AllowAsk()
		rep := sh.be.Preflight(sh.ctx, req)
		done()
		return preflightMsg{rep}
	}
}

// fixable lists the checks that are a secret we can help with.
func (s *cutScreen) fixable() []int {
	if s.rep == nil {
		return nil
	}
	var out []int
	for i, c := range s.rep.Checks {
		if c.State != app.CheckOK && s.statusFor(c.Name) != nil {
			out = append(out, i)
		}
	}
	return out
}

func (s *cutScreen) statusFor(name string) *secrets.Status {
	for i := range s.rep.Secrets {
		if s.rep.Secrets[i].Label == name {
			return &s.rep.Secrets[i]
		}
	}
	return nil
}

func (s *cutScreen) moveCur(d int) {
	fx := s.fixable()
	if len(fx) == 0 {
		s.pfCur = 0
		return
	}
	s.pfCur = min(max(s.pfCur+d, 0), len(fx)-1)
}

func (s *cutScreen) curStatus() *secrets.Status {
	fx := s.fixable()
	if len(fx) == 0 {
		return nil
	}
	return s.statusFor(s.rep.Checks[fx[min(s.pfCur, len(fx)-1)]].Name)
}

func (s *cutScreen) preflightKey(k tea.KeyMsg) (screen, tea.Cmd) {
	switch k.String() {
	case "esc":
		if s.resume != nil {
			s.phase = cpNotes
			return s, nil
		}
		s.phase = cpNotes
		return s, nil
	case "up", "k":
		s.moveCur(-1)
	case "down", "j":
		s.moveCur(1)
	case "r":
		if !s.pfBusy {
			s.fixNote = ""
			return s, s.preflight()
		}
	case "e", "a":
		if st := s.curStatus(); st != nil && !s.pfBusy {
			s.fx = newFixer(s.sh, *st)
			if k.String() == "a" {
				for _, it := range s.fx.items {
					if it.kind == "addpath" {
						s.fx.choose(it)
					}
				}
			}
		}
	case "enter":
		if s.pfBusy || s.rep == nil {
			return s, nil
		}
		if !s.rep.OK() {
			if s.curStatus() != nil {
				s.fx = newFixer(s.sh, *s.curStatus())
			}
			return s, nil
		}
		return s, s.start()
	}
	return s, nil
}

// ---- run

func (s *cutScreen) start() tea.Cmd {
	s.phase, s.started, s.stopping = cpRun, s.sh.now(), false
	s.b = newBoard(s.sh)
	s.sh.newRun()
	// From here on a cut must never stop to ask: preflight proved everything.
	ctx, cancel := context.WithCancel(s.sh.ctx)
	s.cancel = cancel
	sh, req := s.sh, s.req
	req.Notes = s.req.Notes
	return func() tea.Msg {
		defer cancel()
		res, err := sh.be.Cut(ctx, req)
		return cutDoneMsg{res, err}
	}
}

// ---- done

func (s *cutScreen) doneKey(k tea.KeyMsg) (screen, tea.Cmd) {
	switch k.String() {
	case "esc", "q":
		return s, pop()
	case "up", "k":
		s.urlOff = max(s.urlOff-1, 0)
	case "down", "j":
		s.urlOff++
	case "v":
		if s.res != nil && !s.res.Dry {
			return s, push(newVerify(s.sh, s.res.Unit))
		}
	case "r":
		if s.err != nil && s.sh.run.bumpDone && s.version != "" {
			s.req.Resume, s.req.Version, s.req.Bump = true, s.version, ""
			return s, s.toPreflight()
		}
	}
	return s, nil
}

// ---- views

func (s *cutScreen) crumbs() string {
	var parts []string
	for i, n := range cutPhaseNames {
		cur := i == s.phase
		if s.phase == cpDone && i == 4 {
			cur = true
		}
		switch {
		case cur:
			parts = append(parts, selStyle.Render(n))
		case i < s.phase:
			parts = append(parts, n)
		default:
			parts = append(parts, dimStyle.Render(n))
		}
	}
	return strings.Join(parts, dimStyle.Render(" › "))
}

func (s *cutScreen) view(w, h int) frame {
	f := frame{title: "Cut " + s.unit(), info: s.crumbs()}
	if s.version != "" {
		f.title = fmt.Sprintf("Cut %s %s", s.req.Unit, s.version)
		if s.req.Unit == "" {
			f.title = fmt.Sprintf("Cut %s %s", s.unit(), s.version)
		}
	}
	switch s.phase {
	case cpSetup:
		return s.setupView(f, w, h)
	case cpNotes:
		return s.notesView(f, w, h)
	case cpPreflight:
		return s.preflightView(f, w, h)
	case cpRun:
		return s.runView(f, w, h)
	}
	return s.doneView(f, w, h)
}

func (s *cutScreen) setupView(f frame, w, h int) frame {
	f.help = "↑↓ move · ←→ change · d dry run · enter next · esc back"
	row := func(i int, label, value string) string {
		return marker(i == s.row) + pad(label, 10) + value
	}
	arrows := func(i int, v string) string {
		if i == s.row {
			return selStyle.Render("‹ ") + v + selStyle.Render(" ›")
		}
		return "  " + v + "  "
	}
	var lines []string
	lines = append(lines, row(0, "Unit", arrows(0, s.unit())))
	lines = append(lines, row(1, "Channel", arrows(1, s.channel)+dimStyle.Render("  stable is for everyone, beta for testers")))
	var kinds []string
	for i, p := range s.previews {
		v := p.Version
		if p.Err != "" {
			v = "—"
		}
		item := fmt.Sprintf("%s %s", p.Kind, v)
		if i == s.bumpIdx {
			item = selStyle.Render("[" + item + "]")
		} else if p.Err != "" {
			item = dimStyle.Render(item)
		}
		kinds = append(kinds, item)
	}
	lines = append(lines, row(2, "Bump", strings.Join(kinds, "  ")))
	lines = append(lines, row(3, "Dry run", checkbox(s.dry)+dimStyle.Render("  build and sign here, push and upload nothing")))
	lines = append(lines, row(4, "Rebuild", checkbox(s.rebuild)+dimStyle.Render("  Luna: rebuild the OS image and installer")))
	lines = append(lines, "")
	p := s.previews[s.bumpIdx]
	cur := "?"
	if c, _, err := s.sh.be.CutVersion(app.CutRequest{Unit: s.unit(), Channel: s.channel, Bump: p.Kind}); err == nil || p.Version != "" {
		cur = c.String()
	}
	switch {
	case p.Err != "":
		lines = append(lines, "  "+warnStyle.Render("! ")+fit(p.Err, w-6))
	default:
		lines = append(lines, "  "+okStyle.Render("→ ")+panelStyle.Render(p.Version)+dimStyle.Render(" on "+s.channel+" (now "+cur+")"))
		if p.VersionCode > 0 {
			lines = append(lines, "    Android versionCode "+fmt.Sprint(p.VersionCode))
		}
	}
	if s.notice != "" {
		lines = append(lines, "", "  "+warnStyle.Render(fit(s.notice, w-4)))
	}
	if len(s.un) > 0 {
		lines = append(lines, "")
		for _, st := range s.un {
			lines = append(lines, "  "+warnStyle.Render("! ")+fmt.Sprintf("%s %s on %s did not finish. Press r to resume it.", st.Unit, st.Version, st.Channel))
		}
	}
	f.body = lines
	return f
}

func (s *cutScreen) notesView(f frame, w, h int) frame {
	f.help = "ctrl-s continue · esc back"
	if !s.loaded {
		f.body = []string{dimStyle.Render("  Writing a draft from the commit messages since the last tag…")}
		return f
	}
	lines := []string{"  " + dimStyle.Render("Release notes (shown to people in the update screen). Edit freely.")}
	for _, l := range wrapText(s.notesHint, w-6) {
		lines = append(lines, "  "+warnStyle.Render("! ")+l)
	}
	skip := len(lines)
	lines = append(lines, s.ed.view(w-4, h-skip)...)
	for i := skip; i < len(lines); i++ {
		lines[i] = "  " + lines[i]
	}
	f.body = lines
	return f
}

func (s *cutScreen) preflightView(f frame, w, h int) frame {
	if s.fx != nil {
		f.help = s.fx.help()
		f.body = s.fx.view(w, h)
		return f
	}
	if s.rep == nil || s.pfBusy {
		f.help = "esc back"
		lines := []string{dimStyle.Render("  Checking everything before anything is pushed…")}
		if s.rep != nil {
			lines = append(lines, s.checkLines(w, -1)...)
		}
		f.body = lines
		return f
	}
	fx := s.fixable()
	curIdx := -1
	if len(fx) > 0 {
		curIdx = fx[min(s.pfCur, len(fx)-1)]
	}
	lines := s.checkLines(w, curIdx)
	if st := s.curStatus(); st != nil {
		lines = append(lines, "", "  "+dimStyle.Render(st.Label+": "))
		shown := 0
		for _, c := range st.Candidates {
			if shown >= 3 {
				break
			}
			if c.Outcome == secrets.Rejected && strings.HasPrefix(c.Where, "home scan") {
				continue
			}
			g := map[secrets.Outcome]string{secrets.Used: okStyle.Render("✓"), secrets.Valid: okStyle.Render("✓"),
				secrets.Rejected: failStyle.Render("✗"), secrets.Unusable: warnStyle.Render("?")}[c.Outcome]
			why := c.Reason
			if why == "" {
				why = c.Detail
			}
			lines = append(lines, fmt.Sprintf("    %s %s", g, fit(c.Where+" · "+why, w-8)))
			shown++
		}
	}
	if s.fixNote != "" {
		lines = append(lines, "", "  "+dimStyle.Render(s.fixNote))
	}
	if s.rep.OK() {
		f.help = "enter start the cut · r check again · esc back"
		lines = append(lines, "", "  "+okStyle.Render("✓ ")+"Everything is ready. Press enter to start.")
	} else {
		f.help = "e fix this · a add a file or folder · r check again · ↑↓ choose · esc back"
	}
	f.body = lines
	return f
}

func (s *cutScreen) checkLines(w, cur int) []string {
	var lines []string
	for i, c := range s.rep.Checks {
		g := map[string]string{app.CheckOK: okStyle.Render("✓"), app.CheckWarn: warnStyle.Render("!"), app.CheckFail: failStyle.Render("✗")}[c.State]
		name := pad(c.Name, 28)
		if i == cur {
			name = selStyle.Render(name)
		}
		lines = append(lines, marker(i == cur)+g+" "+name+fit(s.sh.redact(c.Detail), w-34))
	}
	return lines
}

func (s *cutScreen) stepGlyph(r *stepRow) string {
	switch r.Phase {
	case app.PhaseDone, app.PhaseSkipped:
		return okStyle.Render("✓")
	case app.PhaseStart:
		return warnStyle.Render("●")
	case app.PhaseFailed:
		return failStyle.Render("✗")
	}
	return dimStyle.Render("◌")
}

var stepLabels = map[string]string{
	publish.StepBump:   "bump commit pushed to origin",
	publish.StepBuild:  "build the exact release commit",
	publish.StepSign:   "sums and signature",
	publish.StepUpload: "upload to the package registry",
	publish.StepVerify: "download again, check hashes",
	publish.StepFeed:   "feed commit on feeds",
	publish.StepMirror: "wait until Forgejo has both commits",
	publish.StepTag:    "tag pushed to Forgejo",
}

func (s *cutScreen) stepLines(w int) []string {
	var lines []string
	for _, r := range s.sh.run.steps {
		note := stepLabels[r.Name]
		switch r.Phase {
		case app.PhaseSkipped:
			note += " (done earlier)"
		case app.PhaseFailed:
			note = r.Err
		}
		name := pad(r.Name, 8)
		if r.Phase == app.PhaseStart {
			name = selStyle.Render(name)
		}
		lines = append(lines, "  "+s.stepGlyph(r)+" "+name+fit(note, w-14))
	}
	return lines
}

func (s *cutScreen) runView(f frame, w, h int) frame {
	f.help = "↑↓ job · enter full log · esc/ctrl-c stop (a stopped cut can be resumed)"
	f.info = s.crumbs()
	if !s.started.IsZero() {
		f.info += dimStyle.Render("  " + clock(s.sh.now().Sub(s.started)))
	}
	if s.stopping {
		f.info = "stopping…"
	}
	if s.b.full {
		f.body = s.b.view(w, h)
		return f
	}
	lines := s.stepLines(w)
	if n := len(s.sh.run.notes); n > 0 {
		lines = append(lines, dimStyle.Render("  › "+fit(s.sh.run.notes[n-1], w-6)))
	} else {
		lines = append(lines, "")
	}
	if s.req.Dry {
		f.title += dimStyle.Render("  (dry run)")
	}
	rest := h - len(lines)
	if rest > 3 && len(s.sh.run.jobs) > 0 {
		lines = append(lines, s.b.view(w, rest)...)
	}
	f.body = lines
	return f
}

func (s *cutScreen) doneView(f frame, w, h int) frame {
	f.info = s.crumbs()
	var lines []string
	switch {
	case s.err != nil:
		stopped := errors.Is(s.err, context.Canceled)
		head := "The cut failed"
		if stopped {
			head = "The cut was stopped"
		}
		lines = append(lines, "  "+failStyle.Render("✗ ")+panelStyle.Render(head))
		if !stopped {
			lines = append(lines, "    "+errTxtStyle.Render(fit(s.sh.redact(s.err.Error()), w-6)))
		}
		lines = append(lines, "")
		if s.sh.run.bumpDone {
			lines = append(lines, "  The bump commit is already pushed. Nothing is done twice: press r to resume,",
				"  or resume later from Home (r).")
			f.help = "r resume · ↑↓ steps · esc back"
		} else {
			lines = append(lines, "  Nothing was pushed, so there is nothing to undo.")
			f.help = "esc back"
		}
		lines = append(lines, "")
		lines = append(lines, s.stepLines(w)...)
	default:
		r := s.res
		verb := "Released"
		if r.Dry {
			verb = "Dry run finished for"
		}
		lines = append(lines, "  "+okStyle.Render("✓ ")+panelStyle.Render(fmt.Sprintf("%s %s %s on %s", verb, r.Unit, r.Version, r.Channel)))
		if r.Dry {
			lines = append(lines, "    Nothing was pushed or uploaded. Feeds are in "+r.OutDir+"/dry-feeds")
		} else {
			lines = append(lines, fmt.Sprintf("    commit %.12s · tag %s", r.SHA, r.Tag))
		}
		lines = append(lines, "", "  "+dimStyle.Render("Feeds"))
		for _, u := range r.FeedURLs {
			lines = append(lines, "    "+fitTail(u, w-6))
		}
		lines = append(lines, "  "+dimStyle.Render(plural(len(r.Files), "file", "files")))
		room := max(h-len(lines), 1)
		off := min(s.urlOff, max(len(r.Files)-room, 0))
		for _, u := range r.Files[off:min(off+room, len(r.Files))] {
			lines = append(lines, "    "+fitTail(u, w-6))
		}
		f.help = "v verify the live feed · ↑↓ files · esc back"
		if r.Dry {
			f.help = "↑↓ files · esc back"
		}
	}
	f.body = lines
	return f
}

var _ = engine.Running
