package tui

import (
	"context"
	"fmt"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/app"
)

type buildDoneMsg struct {
	res []*app.BuildResult
	err error
}

const (
	bpSetup = iota
	bpRunning
	bpDone
)

type buildItem struct {
	kind  int // 0 unit, 1 ref, 2 part, 3 android, 4 start, 5 rebuild
	label string
}

type buildScreen struct {
	sh       *shared
	phase    int
	units    []string
	selected map[string]bool
	ref      *field
	parts    []string
	partSel  map[string]bool
	android  bool
	rebuild  bool
	cur      int
	b        *board
	cancel   context.CancelFunc
	res      []*app.BuildResult
	err      error
	started  time.Time
	ended    time.Time
	stopping bool
	reqUnits []string
	reqRef   string
}

func newBuild(sh *shared, unit string) *buildScreen {
	s := &buildScreen{sh: sh, units: sh.be.Units(), selected: map[string]bool{}, partSel: map[string]bool{},
		ref: newField("HEAD", false), b: newBoard(sh)}
	if unit == "" && len(s.units) > 0 {
		unit = s.units[0]
	}
	s.selected[unit] = true
	s.loadParts()
	return s
}

func (s *buildScreen) init() tea.Cmd { return nil }
func (s *buildScreen) busy() string {
	if s.phase == bpRunning {
		return "build"
	}
	return ""
}

func (s *buildScreen) consumesEsc() bool { return s.b.full }

func (s *buildScreen) stop() {
	if s.cancel != nil {
		s.cancel()
	}
	s.stopping = true
}

func (s *buildScreen) chosen() []string {
	var out []string
	for _, u := range s.units {
		if s.selected[u] {
			out = append(out, u)
		}
	}
	return out
}

func (s *buildScreen) loadParts() {
	s.parts = nil
	if c := s.chosen(); len(c) == 1 {
		s.parts = s.sh.be.PartNames(c[0])
	}
	s.partSel = map[string]bool{}
}

func (s *buildScreen) items() []buildItem {
	var it []buildItem
	for _, u := range s.units {
		it = append(it, buildItem{0, u})
	}
	it = append(it, buildItem{1, "ref"})
	for _, p := range s.parts {
		it = append(it, buildItem{2, p})
	}
	for _, c := range s.chosen() {
		if c == "luna" {
			it = append(it, buildItem{5, "rebuild"})
			break
		}
	}
	if c := s.chosen(); len(c) == 1 && c[0] == "luna-android" {
		it = append(it, buildItem{3, "release"})
	}
	return append(it, buildItem{4, "start"})
}

func (s *buildScreen) update(msg tea.Msg) (screen, tea.Cmd) {
	switch m := msg.(type) {
	case buildDoneMsg:
		s.phase, s.res, s.err, s.ended = bpDone, m.res, m.err, s.sh.now()
		s.cancel = nil
		return s, nil
	case tea.KeyMsg:
		switch s.phase {
		case bpSetup:
			return s.setupKey(m)
		case bpRunning:
			s.b.key(m, s.sh.h-4)
		case bpDone:
			switch m.String() {
			case "esc", "q":
				if s.b.full {
					s.b.full = false
					return s, nil
				}
				return s, pop()
			case "r":
				s.phase = bpSetup
				return s, nil
			default:
				s.b.key(m, s.sh.h-4)
			}
		}
	}
	return s, nil
}

func (s *buildScreen) setupKey(k tea.KeyMsg) (screen, tea.Cmd) {
	it := s.items()
	s.cur = min(s.cur, len(it)-1)
	cur := it[s.cur]
	switch k.String() {
	case "esc":
		return s, pop()
	case "up":
		s.cur = max(s.cur-1, 0)
		return s, nil
	case "down", "tab":
		s.cur = min(s.cur+1, len(it)-1)
		return s, nil
	case "shift+tab":
		s.cur = max(s.cur-1, 0)
		return s, nil
	case "enter", "ctrl+s":
		if len(s.chosen()) == 0 {
			return s, nil
		}
		return s, s.start()
	}
	switch cur.kind {
	case 0:
		if k.String() == " " || k.String() == "x" {
			s.selected[cur.label] = !s.selected[cur.label]
			s.loadParts()
		}
	case 1:
		s.ref.handle(k)
	case 2:
		if k.String() == " " || k.String() == "x" {
			s.partSel[cur.label] = !s.partSel[cur.label]
		}
	case 3:
		if k.String() == " " || k.String() == "x" {
			s.android = !s.android
		}
	case 5:
		if k.String() == " " || k.String() == "x" {
			s.rebuild = !s.rebuild
		}
	}
	return s, nil
}

func (s *buildScreen) start() tea.Cmd {
	s.phase, s.started, s.stopping = bpRunning, s.sh.now(), false
	s.b = newBoard(s.sh)
	s.sh.newRun()
	s.reqUnits = s.chosen()
	s.reqRef = strings.TrimSpace(s.ref.text())
	if s.reqRef == "" {
		s.reqRef = "HEAD"
	}
	ctx, cancel := context.WithCancel(s.sh.ctx)
	s.cancel = cancel
	be := s.sh.be
	var parts []string
	for _, p := range s.parts {
		if s.partSel[p] {
			parts = append(parts, p)
		}
	}
	units, ref, android, rebuild := s.reqUnits, s.reqRef, s.android, s.rebuild
	return func() tea.Msg {
		defer cancel()
		var out []*app.BuildResult
		for _, u := range units {
			res, err := be.Build(ctx, app.BuildRequest{Unit: u, Ref: ref, Parts: parts, AndroidRelease: android && u == "luna-android", Rebuild: rebuild && u == "luna"})
			if res != nil {
				out = append(out, res)
			}
			if err != nil {
				return buildDoneMsg{out, err}
			}
		}
		return buildDoneMsg{out, nil}
	}
}

func (s *buildScreen) view(w, h int) frame {
	switch s.phase {
	case bpSetup:
		return s.setupView(w, h)
	}
	f := frame{title: "Build " + strings.Join(s.reqUnits, ", ") + " · " + s.reqRef}
	end := s.sh.now()
	if s.phase == bpDone {
		end = s.ended
	}
	f.info = clock(end.Sub(s.started))
	var top []string
	if s.phase == bpRunning {
		running := s.sh.run.running()
		state := fmt.Sprintf("%s running", plural(running, "job", "jobs"))
		if s.stopping {
			state = "stopping…"
		}
		top = append(top, dimStyle.Render("  "+state))
		if n := len(s.sh.run.notes); n > 0 && len(s.sh.run.jobs) == 0 {
			top = append(top, dimStyle.Render("  "+fit(s.sh.run.notes[n-1], w-4)))
		}
		f.help = "↑↓ job · enter full log · f follow · esc/ctrl-c stop"
	} else {
		top = s.resultLines(w)
		f.help = "↑↓ job · enter full log · r build again · esc back"
	}
	if s.b.full {
		top = nil
	}
	f.body = append(top, s.b.view(w, h-len(top))...)
	return f
}

func (s *buildScreen) resultLines(w int) []string {
	var out []string
	if s.err != nil {
		out = append(out, "  "+failStyle.Render("✗ ")+fit(s.sh.redact(s.err.Error()), w-6))
	} else {
		out = append(out, "  "+okStyle.Render("✓ ")+"Built "+fmt.Sprintf("in %s", clock(s.ended.Sub(s.started))))
	}
	for _, r := range s.res {
		for _, u := range r.Units {
			size := int64(0)
			for _, f := range u.Files {
				size += f.Size
			}
			out = append(out, fmt.Sprintf("    %s %s: %s, %s → %s", u.Unit, u.Version, plural(len(u.Files), "file", "files"), humanSize(size), s.shortPath(u.Dir)))
		}
	}
	return out
}

func (s *buildScreen) shortPath(p string) string {
	root := s.sh.be.OutRoot()
	if r, ok := strings.CutPrefix(p, root+"/"); ok {
		return "dist/" + r
	}
	return p
}

func humanSize(n int64) string {
	const k = 1024.0
	f := float64(n)
	switch {
	case f >= k*k*k:
		return fmt.Sprintf("%.1f GB", f/(k*k*k))
	case f >= k*k:
		return fmt.Sprintf("%.1f MB", f/(k*k))
	case f >= k:
		return fmt.Sprintf("%.1f KB", f/k)
	}
	return fmt.Sprintf("%d B", n)
}

func (s *buildScreen) setupView(w, h int) frame {
	f := frame{title: "Build", help: "↑↓ move · space choose · enter build · esc back"}
	it := s.items()
	s.cur = min(s.cur, len(it)-1)
	var lines []string
	curLine := 0
	section := func(t string) { lines = append(lines, dimStyle.Render("  "+t)) }
	section("Units to build (from a git export; your working tree is never used)")
	for i, x := range it {
		switch x.kind {
		case 0:
			lines = append(lines, marker(i == s.cur)+checkbox(s.selected[x.label])+" "+x.label)
		case 1:
			if i > 0 && it[i-1].kind == 0 {
				lines = append(lines, "")
				section("Which version of the code")
			}
			lines = append(lines, marker(i == s.cur)+pad("Ref", 6)+s.ref.view(30, i == s.cur)+dimStyle.Render("  a branch, tag or commit"))
		case 2:
			if it[i-1].kind == 1 {
				lines = append(lines, "")
				section("Parts (none chosen builds all of them)")
			}
			lines = append(lines, marker(i == s.cur)+checkbox(s.partSel[x.label])+" "+x.label)
		case 3:
			lines = append(lines, marker(i == s.cur)+checkbox(s.android)+" Sign the APK with the release keystore "+dimStyle.Render("(otherwise debug-signed)"))
		case 5:
			lines = append(lines, marker(i == s.cur)+checkbox(s.rebuild)+" Build the OS image and installer again "+dimStyle.Render("(otherwise reused when nothing changed)"))
		case 4:
			if len(lines) > 0 && lines[len(lines)-1] != "" {
				lines = append(lines, "")
			}
			label := "Start the build"
			if len(s.chosen()) == 0 {
				label = dimStyle.Render("Choose at least one unit")
			}
			lines = append(lines, marker(i == s.cur)+label)
		}
		if i == s.cur {
			curLine = len(lines) - 1
		}
	}
	f.body = window(lines, curLine, h)
	return f
}
