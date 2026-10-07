package tui

import "github.com/charmbracelet/x/ansi"

func lw(s string) int { return ansi.StringWidth(s) }
