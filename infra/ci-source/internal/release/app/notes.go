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

// DraftNotes lists the conventional-commit subjects since the unit's last
// tag that touched the unit's paths, as a markdown list.
func (a *App) DraftNotes(ctx context.Context, unit string) (string, error) {
	paths, ok := unitPaths[unit]
	if !ok {
		return "", nil
	}
	tag, _, found, err := version.LastTag(ctx, a.cfg.Repo, unit, "HEAD")
	if err != nil {
		return "", err
	}
	rng := "HEAD"
	if found {
		rng = tag + "..HEAD"
	}
	args := append([]string{"-C", a.cfg.Repo, "log", "--no-merges", "--format=%s", rng, "--"}, paths...)
	cmd := exec.CommandContext(ctx, "git", args...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git log: %w: %s", err, strings.TrimSpace(errb.String()))
	}
	var b strings.Builder
	for _, l := range strings.Split(out.String(), "\n") {
		l = strings.TrimSpace(l)
		if l == "" || strings.HasPrefix(l, "chore(release):") {
			continue
		}
		b.WriteString("- " + l + "\n")
	}
	return b.String(), nil
}
