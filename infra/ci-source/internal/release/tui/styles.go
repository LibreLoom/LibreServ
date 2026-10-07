// Package tui is the interactive release tool: home, build, cut, secrets.
// It talks to the orchestration layer (internal/release/app) only; it never
// runs a command itself, and never renders a secret value.
package tui

import (
	"fmt"
	"strings"
	"time"

	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
)

// The palette matches the ./ci TUI so both tools feel alike.
var (
	titleStyle  = lipgloss.NewStyle().Bold(true).Foreground(lipgloss.Color("#7C3AED"))
	infoStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("#CDD6F4"))
	selStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#7C3AED")).Bold(true)
	dimStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#888888"))
	okStyle     = lipgloss.NewStyle().Foreground(lipgloss.Color("#22C55E")).Bold(true)
	failStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("#EF4444")).Bold(true)
	warnStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("#F59E0B")).Bold(true)
	ruleStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("#45475A"))
	logStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("#A6E3A1"))
	errTxtStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("#F38BA8"))
	helpStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("#6C7086"))
	panelStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("#CDD6F4")).Bold(true)
	cursorStyle = lipgloss.NewStyle().Reverse(true)
)

// fit cuts s to at most w cells, adding an ellipsis when it was cut.
func fit(s string, w int) string {
	if w <= 0 {
		return ""
	}
	if ansi.StringWidth(s) <= w {
		return s
	}
	return ansi.Truncate(s, w, "…")
}

// pad fits s to exactly w cells.
func pad(s string, w int) string {
	s = fit(s, w)
	if n := w - ansi.StringWidth(s); n > 0 {
		s += strings.Repeat(" ", n)
	}
	return s
}

func rule(w int) string { return ruleStyle.Render(strings.Repeat("─", max(w, 0))) }

// clock formats a duration as m:ss (or h:mm:ss).
func clock(d time.Duration) string {
	s := int(d.Round(time.Second).Seconds())
	if s < 0 {
		s = 0
	}
	if s >= 3600 {
		return fmt.Sprintf("%d:%02d:%02d", s/3600, s%3600/60, s%60)
	}
	return fmt.Sprintf("%d:%02d", s/60, s%60)
}

// ago formats the age of t as 5m, 3h or 9d.
func ago(t, now time.Time) string {
	if t.IsZero() {
		return ""
	}
	d := now.Sub(t)
	switch {
	case d < time.Minute:
		return "now"
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

// window picks the h lines of lines that keep index cur visible.
func window(lines []string, cur, h int) []string {
	if h <= 0 {
		return nil
	}
	if len(lines) <= h {
		return lines
	}
	start := cur - h/2
	if start < 0 {
		start = 0
	}
	if start > len(lines)-h {
		start = len(lines) - h
	}
	return lines[start : start+h]
}

// fill pads or cuts lines to exactly h lines.
func fill(lines []string, h int) []string {
	if len(lines) > h {
		return lines[:h]
	}
	for len(lines) < h {
		lines = append(lines, "")
	}
	return lines
}

func marker(sel bool) string {
	if sel {
		return selStyle.Render("▸ ")
	}
	return "  "
}

func checkbox(on bool) string {
	if on {
		return "[x]"
	}
	return "[ ]"
}

func plural(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("%d %s", n, one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

// fitTail cuts the front of s (a URL's end says more than its start).
func fitTail(s string, w int) string {
	r := []rune(s)
	if len(r) <= w || w < 2 {
		return fit(s, w)
	}
	return "…" + string(r[len(r)-(w-1):])
}

// fitMid cuts the middle of s so both its start and its end stay readable
// (paths).
func fitMid(s string, w int) string {
	r := []rune(s)
	if len(r) <= w || w < 5 {
		return fit(s, w)
	}
	head := (w - 1) / 3
	tail := w - 1 - head
	return string(r[:head]) + "…" + string(r[len(r)-tail:])
}

// wrapText breaks s into lines of at most w cells at spaces.
func wrapText(s string, w int) []string {
	if w < 8 {
		return []string{fit(s, w)}
	}
	var out []string
	line := ""
	for _, word := range strings.Fields(s) {
		for lw(word) > w {
			if line != "" {
				out = append(out, line)
				line = ""
			}
			out = append(out, ansi.Truncate(word, w, ""))
			word = ansi.TruncateLeft(word, w, "")
		}
		switch {
		case line == "":
			line = word
		case lw(line)+1+lw(word) <= w:
			line += " " + word
		default:
			out = append(out, line)
			line = word
		}
	}
	if line != "" {
		out = append(out, line)
	}
	return out
}
