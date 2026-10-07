package version

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// Units maps each release unit to its VERSION file, relative to the repo root.
var Units = map[string]string{
	"sol":          "sol/VERSION",
	"sol-connect":  "sol/connect/VERSION",
	"luna":         "luna/VERSION",
	"luna-desktop": "luna/desktop/VERSION",
	"luna-android": "luna/mobile/VERSION",
	"luna-connect": "luna/connect/VERSION",
}

// UnitNames returns the unit names, sorted.
func UnitNames() []string {
	names := make([]string, 0, len(Units))
	for n := range Units {
		names = append(names, n)
	}
	sort.Strings(names)
	return names
}

// ReadFile reads and strictly parses a VERSION file.
func ReadFile(path string) (Version, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return Version{}, err
	}
	v, err := Parse(strings.TrimSpace(string(b)))
	if err != nil {
		return Version{}, fmt.Errorf("%s: %w", path, err)
	}
	return v, nil
}

// ReadUnit reads a unit's VERSION from the working tree at repo.
func ReadUnit(repo, unit string) (Version, error) {
	rel, ok := Units[unit]
	if !ok {
		return Version{}, fmt.Errorf("unknown unit %q (have %s)", unit, strings.Join(UnitNames(), ", "))
	}
	return ReadFile(filepath.Join(repo, rel))
}

// Tag returns the git tag for a unit release: "<unit>/vX.Y.Z".
func Tag(unit string, v Version) string { return unit + "/v" + v.String() }

// ParseTag splits "<unit>/vX.Y.Z" into its unit and version.
func ParseTag(tag string) (string, Version, error) {
	unit, rest, ok := strings.Cut(tag, "/v")
	if !ok || unit == "" {
		return "", Version{}, fmt.Errorf("tag %q: want <unit>/vX.Y.Z", tag)
	}
	v, err := Parse(rest)
	if err != nil {
		return "", Version{}, fmt.Errorf("tag %q: %w", tag, err)
	}
	return unit, v, nil
}

func git(ctx context.Context, repo string, args ...string) (string, error) {
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", repo}, args...)...)
	var out, errb bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &errb
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("git %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(errb.String()))
	}
	return strings.TrimSpace(out.String()), nil
}

// LastTag finds the highest-versioned "<unit>/v*" tag reachable from ref.
// It returns ok=false when the unit has no tag yet.
func LastTag(ctx context.Context, repo, unit, ref string) (tag string, v Version, ok bool, err error) {
	out, err := git(ctx, repo, "tag", "--list", unit+"/v*", "--merged", ref)
	if err != nil {
		return "", Version{}, false, err
	}
	for _, t := range strings.Fields(out) {
		u, tv, perr := ParseTag(t)
		if perr != nil || u != unit {
			continue
		}
		if !ok || tv.Compare(v) > 0 {
			tag, v, ok = t, tv, true
		}
	}
	return tag, v, ok, nil
}

// CommitsSince counts commits in ref that are not in tag (all of ref's
// history when tag is empty).
func CommitsSince(ctx context.Context, repo, tag, ref string) (int, error) {
	rng := ref
	if tag != "" {
		rng = tag + ".." + ref
	}
	out, err := git(ctx, repo, "rev-list", "--count", rng)
	if err != nil {
		return 0, err
	}
	return strconv.Atoi(out)
}

// DevVersion computes the dev version of a unit at ref. With a unit tag it is
// Dev(tag version, commits since tag); without one it is built from the
// unit's VERSION file at ref and the commit count of ref's history.
func DevVersion(ctx context.Context, repo, unit, ref string) (Version, error) {
	rel, ok := Units[unit]
	if !ok {
		return Version{}, fmt.Errorf("unknown unit %q", unit)
	}
	tag, last, found, err := LastTag(ctx, repo, unit, ref)
	if err != nil {
		return Version{}, err
	}
	if !found {
		out, err := git(ctx, repo, "show", ref+":"+rel)
		if err != nil {
			return Version{}, err
		}
		if last, err = Parse(strings.TrimSpace(out)); err != nil {
			return Version{}, fmt.Errorf("%s at %s: %w", rel, ref, err)
		}
	}
	n, err := CommitsSince(ctx, repo, tag, ref)
	if err != nil {
		return Version{}, err
	}
	return Dev(last, n), nil
}
