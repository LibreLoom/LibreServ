package tui

import (
	"fmt"
	"strings"

	tea "github.com/charmbracelet/bubbletea"
)

// field is a one-line text input. A secret field never shows what was typed
// (only how many characters), and keeps newlines of a paste so a whole key
// file can be pasted.
type field struct {
	val    []rune
	cur    int
	secret bool
	multi  bool // keep newlines from a paste (secret keys)
	hint   string
}

func newField(initial string, secret bool) *field {
	f := &field{val: []rune(initial), secret: secret}
	f.cur = len(f.val)
	return f
}

func (f *field) text() string { return string(f.val) }
func (f *field) empty() bool  { return len(f.val) == 0 }
func (f *field) clear()       { f.val, f.cur = nil, 0 }

func (f *field) insert(rs []rune) {
	if !f.multi {
		out := rs[:0:0]
		for _, r := range rs {
			if r != '\n' && r != '\r' {
				out = append(out, r)
			}
		}
		rs = out
	}
	f.val = append(f.val[:f.cur], append(append([]rune{}, rs...), f.val[f.cur:]...)...)
	f.cur += len(rs)
}

// handle edits the field; it reports whether the key was an edit.
func (f *field) handle(k tea.KeyMsg) bool {
	switch k.Type {
	case tea.KeyRunes:
		f.insert(k.Runes)
	case tea.KeySpace:
		f.insert([]rune{' '})
	case tea.KeyBackspace:
		if f.cur > 0 {
			f.val = append(f.val[:f.cur-1], f.val[f.cur:]...)
			f.cur--
		}
	case tea.KeyDelete:
		if f.cur < len(f.val) {
			f.val = append(f.val[:f.cur], f.val[f.cur+1:]...)
		}
	case tea.KeyLeft:
		if f.cur > 0 {
			f.cur--
		}
	case tea.KeyRight:
		if f.cur < len(f.val) {
			f.cur++
		}
	case tea.KeyHome, tea.KeyCtrlA:
		f.cur = 0
	case tea.KeyEnd, tea.KeyCtrlE:
		f.cur = len(f.val)
	case tea.KeyCtrlU:
		f.val, f.cur = f.val[f.cur:], 0
	case tea.KeyCtrlW:
		i := f.cur
		for i > 0 && f.val[i-1] == ' ' {
			i--
		}
		for i > 0 && f.val[i-1] != ' ' {
			i--
		}
		f.val = append(f.val[:i], f.val[f.cur:]...)
		f.cur = i
	default:
		return false
	}
	return true
}

// view renders the field in w cells.
func (f *field) view(w int, focused bool) string {
	if f.secret {
		if len(f.val) == 0 {
			if focused {
				return cursorStyle.Render(" ")
			}
			return dimStyle.Render("(empty)")
		}
		bullets := min(len(f.val), max(w-20, 4))
		s := strings.Repeat("•", bullets)
		if len(f.val) > bullets || f.multi {
			s += fmt.Sprintf(" (%d characters)", len(f.val))
		}
		if focused {
			s += cursorStyle.Render(" ")
		}
		return fit(s, w)
	}
	s := string(f.val)
	if !focused {
		if s == "" && f.hint != "" {
			return dimStyle.Render(fit(f.hint, w))
		}
		return fit(s, w)
	}
	// Scroll so the cursor stays visible.
	start := 0
	if f.cur > w-2 {
		start = f.cur - (w - 2)
	}
	rs := f.val[start:]
	cur := f.cur - start
	var before, at, after string
	before = string(rs[:cur])
	if cur < len(rs) {
		at, after = string(rs[cur]), string(rs[cur+1:])
	} else {
		at = " "
	}
	return fit(before, w) + cursorStyle.Render(at) + fit(after, max(w-len([]rune(before))-1, 0))
}

// editor is a small multi-line text editor for the release notes.
type editor struct {
	lines [][]rune
	row   int
	col   int
	top   int
}

func newEditor(text string) *editor {
	e := &editor{}
	for _, l := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		e.lines = append(e.lines, []rune(l))
	}
	if len(e.lines) == 0 {
		e.lines = [][]rune{{}}
	}
	e.row = len(e.lines) - 1
	e.col = len(e.lines[e.row])
	return e
}

func (e *editor) text() string {
	var ls []string
	for _, l := range e.lines {
		ls = append(ls, string(l))
	}
	return strings.TrimRight(strings.Join(ls, "\n"), "\n ") + "\n"
}

func (e *editor) insert(rs []rune) {
	for _, r := range rs {
		switch r {
		case '\r':
		case '\n':
			e.newline()
		default:
			l := e.lines[e.row]
			e.lines[e.row] = append(l[:e.col], append([]rune{r}, l[e.col:]...)...)
			e.col++
		}
	}
}

func (e *editor) newline() {
	l := e.lines[e.row]
	rest := append([]rune{}, l[e.col:]...)
	e.lines[e.row] = l[:e.col]
	e.lines = append(e.lines[:e.row+1], append([][]rune{rest}, e.lines[e.row+1:]...)...)
	e.row++
	e.col = 0
}

func (e *editor) handle(k tea.KeyMsg, page int) {
	switch k.Type {
	case tea.KeyRunes:
		e.insert(k.Runes)
	case tea.KeySpace:
		e.insert([]rune{' '})
	case tea.KeyEnter:
		e.newline()
	case tea.KeyTab:
		e.insert([]rune("  "))
	case tea.KeyBackspace:
		switch {
		case e.col > 0:
			l := e.lines[e.row]
			e.lines[e.row] = append(l[:e.col-1], l[e.col:]...)
			e.col--
		case e.row > 0:
			prev := e.lines[e.row-1]
			e.col = len(prev)
			e.lines[e.row-1] = append(prev, e.lines[e.row]...)
			e.lines = append(e.lines[:e.row], e.lines[e.row+1:]...)
			e.row--
		}
	case tea.KeyDelete:
		l := e.lines[e.row]
		switch {
		case e.col < len(l):
			e.lines[e.row] = append(l[:e.col], l[e.col+1:]...)
		case e.row < len(e.lines)-1:
			e.lines[e.row] = append(l, e.lines[e.row+1]...)
			e.lines = append(e.lines[:e.row+1], e.lines[e.row+2:]...)
		}
	case tea.KeyLeft:
		if e.col > 0 {
			e.col--
		} else if e.row > 0 {
			e.row--
			e.col = len(e.lines[e.row])
		}
	case tea.KeyRight:
		if e.col < len(e.lines[e.row]) {
			e.col++
		} else if e.row < len(e.lines)-1 {
			e.row++
			e.col = 0
		}
	case tea.KeyUp:
		e.moveRow(-1)
	case tea.KeyDown:
		e.moveRow(1)
	case tea.KeyPgUp:
		e.moveRow(-page)
	case tea.KeyPgDown:
		e.moveRow(page)
	case tea.KeyHome, tea.KeyCtrlA:
		e.col = 0
	case tea.KeyEnd, tea.KeyCtrlE:
		e.col = len(e.lines[e.row])
	}
}

func (e *editor) moveRow(d int) {
	e.row = min(max(e.row+d, 0), len(e.lines)-1)
	e.col = min(e.col, len(e.lines[e.row]))
}

// view renders h lines of w cells with the cursor visible.
func (e *editor) view(w, h int) []string {
	if e.row < e.top {
		e.top = e.row
	}
	if e.row >= e.top+h {
		e.top = e.row - h + 1
	}
	var out []string
	for i := e.top; i < min(e.top+h, len(e.lines)); i++ {
		l := e.lines[i]
		if i != e.row {
			out = append(out, fit(string(l), w))
			continue
		}
		start := 0
		if e.col > w-2 {
			start = e.col - (w - 2)
		}
		rs := l[start:]
		c := e.col - start
		at := " "
		after := ""
		if c < len(rs) {
			at, after = string(rs[c]), string(rs[c+1:])
		}
		out = append(out, string(rs[:c])+cursorStyle.Render(at)+after)
	}
	return fill(out, h)
}
