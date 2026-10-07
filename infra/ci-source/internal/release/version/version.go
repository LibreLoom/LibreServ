// Package version reads unit VERSION files and implements the release tool's
// version rules: strict semver, dev versions, tags, and Android versionCode.
package version

import (
	"errors"
	"fmt"
	"strconv"
	"strings"
)

// Version is a strict semver 2.0 version without a leading "v".
type Version struct {
	Major, Minor, Patch int
	// Pre holds the dot-separated pre-release identifiers, e.g. ["beta", "2"].
	Pre []string
}

// Parse parses a strict semver string: no leading "v", no leading zeros, no
// "+build" metadata (the receivers' bash semver check rejects it).
func Parse(s string) (Version, error) {
	var v Version
	if s == "" {
		return v, errors.New("empty version")
	}
	if strings.ContainsAny(s, "+ \t\r\n") {
		return v, fmt.Errorf("version %q: build metadata and whitespace are not allowed", s)
	}
	core, pre, hasPre := strings.Cut(s, "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 {
		return v, fmt.Errorf("version %q: want MAJOR.MINOR.PATCH", s)
	}
	nums := [3]int{}
	for i, p := range parts {
		n, err := parseNumeric(p)
		if err != nil {
			return v, fmt.Errorf("version %q: %w", s, err)
		}
		nums[i] = n
	}
	v.Major, v.Minor, v.Patch = nums[0], nums[1], nums[2]
	if hasPre {
		if pre == "" {
			return v, fmt.Errorf("version %q: empty pre-release", s)
		}
		for _, id := range strings.Split(pre, ".") {
			if id == "" {
				return v, fmt.Errorf("version %q: empty pre-release identifier", s)
			}
			for _, r := range id {
				if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r == '-') {
					return v, fmt.Errorf("version %q: bad character %q in pre-release", s, r)
				}
			}
			if isNumeric(id) {
				if _, err := parseNumeric(id); err != nil {
					return v, fmt.Errorf("version %q: pre-release: %w", s, err)
				}
			}
			v.Pre = append(v.Pre, id)
		}
	}
	return v, nil
}

// MustParse is Parse that panics; for tests and constants.
func MustParse(s string) Version {
	v, err := Parse(s)
	if err != nil {
		panic(err)
	}
	return v
}

func isNumeric(s string) bool {
	if s == "" {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func parseNumeric(s string) (int, error) {
	if !isNumeric(s) {
		return 0, fmt.Errorf("%q is not a number", s)
	}
	if len(s) > 1 && s[0] == '0' {
		return 0, fmt.Errorf("%q has a leading zero", s)
	}
	n, err := strconv.Atoi(s)
	if err != nil {
		return 0, fmt.Errorf("%q: %w", s, err)
	}
	return n, nil
}

func (v Version) String() string {
	s := fmt.Sprintf("%d.%d.%d", v.Major, v.Minor, v.Patch)
	if len(v.Pre) > 0 {
		s += "-" + strings.Join(v.Pre, ".")
	}
	return s
}

// IsPrerelease reports whether v has pre-release identifiers.
func (v Version) IsPrerelease() bool { return len(v.Pre) > 0 }

// Compare returns -1, 0 or 1 following semver 2.0 precedence.
func (v Version) Compare(o Version) int {
	for _, p := range [][2]int{{v.Major, o.Major}, {v.Minor, o.Minor}, {v.Patch, o.Patch}} {
		if c := cmpInt(p[0], p[1]); c != 0 {
			return c
		}
	}
	switch {
	case len(v.Pre) == 0 && len(o.Pre) == 0:
		return 0
	case len(v.Pre) == 0:
		return 1
	case len(o.Pre) == 0:
		return -1
	}
	for i := 0; i < len(v.Pre) && i < len(o.Pre); i++ {
		a, b := v.Pre[i], o.Pre[i]
		an, bn := isNumeric(a), isNumeric(b)
		var c int
		switch {
		case an && bn:
			x, _ := strconv.Atoi(a)
			y, _ := strconv.Atoi(b)
			c = cmpInt(x, y)
		case an:
			c = -1
		case bn:
			c = 1
		default:
			c = strings.Compare(a, b)
		}
		if c != 0 {
			return c
		}
	}
	return cmpInt(len(v.Pre), len(o.Pre))
}

// Less reports v < o.
func (v Version) Less(o Version) bool { return v.Compare(o) < 0 }

// Compare parses and compares two version strings.
func Compare(a, b string) (int, error) {
	x, err := Parse(a)
	if err != nil {
		return 0, err
	}
	y, err := Parse(b)
	if err != nil {
		return 0, err
	}
	return x.Compare(y), nil
}

func cmpInt(a, b int) int {
	switch {
	case a < b:
		return -1
	case a > b:
		return 1
	}
	return 0
}

// BetaNumber returns N for a version whose pre-release is exactly "beta.N".
func (v Version) BetaNumber() (int, bool) {
	if len(v.Pre) == 2 && v.Pre[0] == "beta" && isNumeric(v.Pre[1]) {
		n, err := strconv.Atoi(v.Pre[1])
		return n, err == nil
	}
	return 0, false
}

// AndroidVersionCode is (major*10000+minor*100+patch)*100+n where n is the
// beta number (1-98) or 99 for a final release. Other pre-releases (such as
// dev builds) have no versionCode.
func (v Version) AndroidVersionCode() (int, error) {
	if v.Minor > 99 || v.Patch > 99 {
		return 0, fmt.Errorf("version %s: minor and patch must be below 100 for versionCode", v)
	}
	n := 99
	if v.IsPrerelease() {
		b, ok := v.BetaNumber()
		if !ok || b < 1 || b > 98 {
			return 0, fmt.Errorf("version %s: only X.Y.Z and X.Y.Z-beta.N (1-98) have a versionCode", v)
		}
		n = b
	}
	return (v.Major*10000+v.Minor*100+v.Patch)*100 + n, nil
}

// Bump kinds accepted by Next.
const (
	BumpPatch = "patch"
	BumpMinor = "minor"
	BumpMajor = "major"
	BumpBeta  = "beta"
)

// Next computes the version a cut of the given kind produces from the
// current released version. A beta of a final X.Y.Z is X.Y.(Z+1)-beta.1; a
// beta of a beta is the next beta number; patch/minor/major of a beta
// finalises it (patch) or bumps the core as usual.
func (v Version) Next(kind string) (Version, error) {
	switch kind {
	case BumpPatch:
		if v.IsPrerelease() {
			return Version{Major: v.Major, Minor: v.Minor, Patch: v.Patch}, nil
		}
		return Version{Major: v.Major, Minor: v.Minor, Patch: v.Patch + 1}, nil
	case BumpMinor:
		return Version{Major: v.Major, Minor: v.Minor + 1}, nil
	case BumpMajor:
		return Version{Major: v.Major + 1}, nil
	case BumpBeta:
		if n, ok := v.BetaNumber(); ok {
			return Version{Major: v.Major, Minor: v.Minor, Patch: v.Patch, Pre: []string{"beta", strconv.Itoa(n + 1)}}, nil
		}
		if v.IsPrerelease() {
			return Version{}, fmt.Errorf("cannot beta-bump %s", v)
		}
		return Version{Major: v.Major, Minor: v.Minor, Patch: v.Patch + 1, Pre: []string{"beta", "1"}}, nil
	}
	return Version{}, fmt.Errorf("unknown bump %q", kind)
}

// Dev returns the dev/HEAD version for a tree `commits` commits after the
// last unit tag `last`: "<next patch>-0.dev.<commits>", e.g. 0.4.1-0.dev.12.
// It sorts below every beta and release of that version. If `last` is itself
// a pre-release, the upcoming version has the same core, so the core is kept
// (0.4.0-beta.2 -> 0.4.0-0.dev.N, still below 0.4.0-beta.2... and 0.4.0).
// No "+build" metadata is ever added.
func Dev(last Version, commits int) Version {
	core := Version{Major: last.Major, Minor: last.Minor, Patch: last.Patch}
	if !last.IsPrerelease() {
		core.Patch++
	}
	core.Pre = []string{"0", "dev", strconv.Itoa(commits)}
	return core
}
