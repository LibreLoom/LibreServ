package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
)

// board shows the build jobs of a runState and the log of the selected one.
// Build and cut share it.
type board struct {
	sh   *shared
	sel  int
	auto bool // follow the newest running job until the user moves
	full bool // the log fills the screen
	off  int  // lines scrolled up from the end of the log
}

func newBoard(sh *shared) *board { return &board{sh: sh, auto: true} }

func (b *board) jobs() []*jobRow { return b.sh.run.jobs }

// follow keeps the selection on the job that is doing something.
func (b *board) follow() {
	js := b.jobs()
	if !b.auto || len(js) == 0 {
		return
	}
	pick := -1
	for i, j := range js {
		if j.Status == engine.Running {
			pick = i
		}
	}
	if pick < 0 {
		for i, j := range js {
			if j.Status.Done() && j.Status != engine.Skipped {
				pick = i
			}
		}
	}
	if pick >= 0 {
		if pick != b.sel {
			b.off = 0
		}
		b.sel = pick
	}
}

// key handles job selection and log scrolling; it reports whether it used the key.
func (b *board) key(k tea.KeyMsg, h int) bool {
	js := b.jobs()
	switch k.String() {
	case "up", "k":
		if b.full {
			b.off++
		} else if len(js) > 0 {
			b.auto, b.off = false, 0
			b.sel = max(b.sel-1, 0)
		}
	case "down", "j":
		if b.full {
			b.off = max(b.off-1, 0)
		} else if len(js) > 0 {
			b.auto, b.off = false, 0
			b.sel = min(b.sel+1, len(js)-1)
		}
	case "pgup":
		b.off += max(h-2, 1)
	case "pgdown":
		b.off = max(b.off-max(h-2, 1), 0)
	case "g":
		b.off = 1 << 30
	case "G", "end":
		b.off = 0
	case "enter":
		b.full = !b.full
	case "f":
		b.auto, b.off = true, 0
	case "esc":
		if b.full {
			b.full = false
			return true
		}
		return false
	default:
		return false
	}
	return true
}

func glyph(s engine.Status) string {
	switch s {
	case engine.Succeeded:
		return okStyle.Render("✓")
	case engine.Failed:
		return failStyle.Render("✗")
	case engine.Running:
		return warnStyle.Render("●")
	case engine.Cancelled:
		return warnStyle.Render("⊘")
	case engine.Skipped:
		return dimStyle.Render("–")
	}
	return dimStyle.Render("◌")
}

func (b *board) row(j *jobRow, sel bool, w int) string {
	r := b.sh.run
	var t string
	switch {
	case j.Status == engine.Running:
		t = clock(b.sh.now().Sub(j.Started))
	case j.Status.Done() && j.Status != engine.Skipped:
		t = clock(j.Elapsed)
	}
	var detail string
	switch j.Status {
	case engine.Running:
		if n := len(j.Log); n > 0 {
			detail = j.Log[n-1]
		}
	case engine.Failed:
		detail = firstLine(j.Err)
	case engine.Pending:
		if wf := r.waitsFor(j); len(wf) > 0 {
			detail = "waits for " + strings.Join(wf, ", ")
		}
	case engine.Skipped:
		detail = "not started"
	case engine.Cancelled:
		detail = "cancelled"
	}
	name := pad(r.name(j), 14)
	if sel {
		name = selStyle.Render(name)
	}
	title := ""
	if j.Title != "" && j.Title != j.ID {
		title = j.Title
	}
	used := 2 + 2 + 14 + 22 + 7
	return marker(sel) + glyph(j.Status) + " " + name + pad(dimStyle.Render(fit(title, 21)), 22) + pad(t, 7) + fit(detail, max(w-used, 4))
}

func firstLine(s string) string {
	l, _, _ := strings.Cut(s, "\n")
	return l
}

// view draws h lines: the jobs, then the selected job's log.
func (b *board) view(w, h int) []string {
	b.follow()
	js := b.jobs()
	if len(js) == 0 {
		return fill([]string{dimStyle.Render("  Waiting for the first job…")}, h)
	}
	b.sel = min(b.sel, len(js)-1)
	cur := js[b.sel]
	if b.full {
		return b.logLines(cur, w, h)
	}
	lh := min(len(js), max(3, h*45/100))
	if h-lh < 4 {
		lh = max(h-4, 1)
	}
	var rows []string
	for i, j := range js {
		rows = append(rows, b.row(j, i == b.sel, w))
	}
	out := append([]string{}, window(rows, b.sel, lh)...)
	out = append(out, rule(w))
	return append(out, b.logLines(cur, w, h-len(out))...)
}

// logLines shows the tail of a job's log, scrolled back by b.off lines.
func (b *board) logLines(j *jobRow, w, h int) []string {
	head := " " + selStyle.Render(b.sh.run.name(j))
	if j.Status == engine.Failed && j.Err != "" {
		head += "  " + errTxtStyle.Render(fit(firstLine(j.Err), w-lw(head)-4))
	}
	if h <= 1 {
		return []string{fit(head, w)}
	}
	n := len(j.Log)
	room := h - 1
	b.off = min(b.off, max(n-room, 0))
	end := n - b.off
	start := max(end-room, 0)
	out := []string{head}
	for _, l := range j.Log[start:end] {
		out = append(out, "  "+logStyle.Render(fit(l, w-3)))
	}
	if n == 0 {
		out = append(out, dimStyle.Render("  (no output yet)"))
	}
	if b.off > 0 {
		out[0] = fit(head, w-14) + dimStyle.Render(fmt.Sprintf("  ↑ %d above", b.off))
	}
	return fill(out, h)
}
