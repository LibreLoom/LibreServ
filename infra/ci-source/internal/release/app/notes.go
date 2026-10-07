package app

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/version"
)

// unitPaths are the git pathspecs a unit's release notes cover.
var unitPaths = map[string][]string{
	"sol":          {"sol", ":(exclude)sol/connect"},
	"sol-connect":  {"sol/connect"},
	"luna":         {"luna", ":(exclude)luna/desktop", ":(exclude)luna/mobile", ":(exclude)luna/connect"},
	"luna-desktop": {"luna/desktop"},
	"luna-android": {"luna/mobile"},
	"luna-connect": {"luna/connect"},
}

const (
	maxDraftLines = 25
	// maxDraftHistory bounds how many commits are looked at at all.
	maxDraftHistory = 400
)

// NotesDraft is a first draft of release notes.
type NotesDraft struct {
	Text string
	// Since is the tag the list starts from ("" when it covers all history).
	Since string
	// FirstRelease is true when the unit has no release made with this tool
	// yet, so the draft is only a starting point.
	FirstRelease bool
	// Omitted counts the changes left out to keep the list short.
	Omitted int
}

// Hint is a plain sentence for the person writing the notes ("" when the
// draft needs no warning).
func (d NotesDraft) Hint() string {
	switch {
	case d.FirstRelease && d.Since != "":
		return "First release with this tool. The list below is only the changes since the old tag " + d.Since + ". Write the real notes yourself."
	case d.FirstRelease:
		return "This unit has no earlier release, so the list below is only a start. Write the real notes yourself."
	}
	return ""
}

// isBotAuthor reports whether a commit author is one of the repository's bots
// (docs-bot, lock-bot, atlas-bot and the like).
func isBotAuthor(name string) bool {
	n := strings.ToLower(strings.TrimSpace(name))
	return strings.HasSuffix(n, "-bot") || strings.HasSuffix(n, "[bot]") || n == "atlas"
}

// NotesDraft lists the conventional-commit subjects since the unit's last
// tag (or its newest old-style tag) that touched the unit's own paths, left
// out: bot commits and release commits; capped in length.
func (a *App) NotesDraft(ctx context.Context, unit string) (NotesDraft, error) {
	var d NotesDraft
	paths, ok := unitPaths[unit]
	if !ok {
		return d, nil
	}
	tag, legacy, found, err := version.NotesBase(ctx, a.cfg.Repo, unit, "HEAD")
	if err != nil {
		return d, err
	}
	d.FirstRelease = !found || legacy
	rng := "HEAD"
	if found {
		rng = tag + "..HEAD"
		d.Since = tag
	}
	args := append([]string{"-C", a.cfg.Repo, "log", "--no-merges", fmt.Sprintf("--max-count=%d", maxDraftHistory),
		"--format=%an%x09%s", rng, "--"}, paths...)
	cmd := exec.CommandContext(ctx, "git", args...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return d, fmt.Errorf("git log: %w: %s", err, strings.TrimSpace(errb.String()))
	}
	var b strings.Builder
	n := 0
	for _, l := range strings.Split(out.String(), "\n") {
		author, subject, _ := strings.Cut(l, "\t")
		subject = strings.TrimSpace(subject)
		if subject == "" || isBotAuthor(author) || strings.HasPrefix(subject, "chore(release):") ||
			strings.HasPrefix(subject, "Merge ") {
			continue
		}
		if n >= maxDraftLines {
			d.Omitted++
			continue
		}
		n++
		b.WriteString("- " + subject + "\n")
	}
	if d.Omitted > 0 {
		b.WriteString(fmt.Sprintf("- …and %d more changes\n", d.Omitted))
	}
	d.Text = b.String()
	return d, nil
}

// DraftNotes is NotesDraft's text.
func (a *App) DraftNotes(ctx context.Context, unit string) (string, error) {
	d, err := a.NotesDraft(ctx, unit)
	return d.Text, err
}
