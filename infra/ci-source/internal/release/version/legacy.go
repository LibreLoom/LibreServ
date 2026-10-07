package version

import (
	"context"
	"strings"
)

// legacyTagGlobs are the tag names the repository used before units were
// tagged "<unit>/v<version>".
var legacyTagGlobs = map[string]string{
	"sol":          "v[0-9]*",
	"luna":         "luna-v[0-9]*",
	"sol-connect":  "connect-v[0-9]*",
	"luna-connect": "luna-connect-v[0-9]*",
	"luna-android": "luna-android-[0-9]*",
	"luna-desktop": "luna-desktop-[0-9]*",
}

// LegacyTag finds the newest old-style tag of a unit reachable from ref. It
// is only a place to start counting changes from (release notes, "commits
// since"), never a source of version numbers.
func LegacyTag(ctx context.Context, repo, unit, ref string) (tag string, ok bool) {
	glob, has := legacyTagGlobs[unit]
	if !has {
		return "", false
	}
	out, err := git(ctx, repo, "tag", "--list", glob, "--merged", ref, "--sort=-version:refname")
	if err != nil {
		return "", false
	}
	if f := strings.Fields(out); len(f) > 0 {
		return f[0], true
	}
	return "", false
}

// NotesBase is the tag release notes and "commits since" start from: the
// unit's newest tag, else its newest old-style tag. ok is false when there is
// neither. legacy tells which kind it is.
func NotesBase(ctx context.Context, repo, unit, ref string) (tag string, legacy, ok bool, err error) {
	tag, _, found, err := LastTag(ctx, repo, unit, ref)
	if err != nil {
		return "", false, false, err
	}
	if found {
		return tag, false, true, nil
	}
	tag, ok = LegacyTag(ctx, repo, unit, ref)
	return tag, true, ok, nil
}
