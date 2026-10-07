package app

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/version"
)

const (
	androidGradle = "luna/mobile/app/build.gradle.kts"
	desktopInfo   = "luna/desktop/packaging/flatpak/org.libreloom.LunaDesktop.metainfo.xml"
)

var (
	gradleCodeRE = regexp.MustCompile(`(?m)^(\s*versionCode\s*=\s*)\d+`)
	gradleNameRE = regexp.MustCompile(`(?m)^(\s*versionName\s*=\s*)"[^"]*"`)
)

// bumpFunc returns the publish.Config.Bump callback for unit -> v. It is
// idempotent (a rebase retry applies it again): VERSION is rewritten, the
// Android literals are replaced in place, and the desktop metainfo gets one
// <release> entry per version.
func (a *App) bumpFunc(unit string, v version.Version, now time.Time) func(dir string) ([]string, error) {
	return func(dir string) ([]string, error) {
		rel, ok := a.cfg.VersionFiles[unit]
		if !ok {
			return nil, fmt.Errorf("unit %q has no VERSION file", unit)
		}
		changed := []string{rel}
		if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, rel)), 0o755); err != nil {
			return nil, err
		}
		if err := os.WriteFile(filepath.Join(dir, rel), []byte(v.String()+"\n"), 0o644); err != nil {
			return nil, err
		}
		switch unit {
		case "luna-android":
			code, err := v.AndroidVersionCode()
			if err != nil {
				return nil, err
			}
			if err := editFile(filepath.Join(dir, androidGradle), func(s string) (string, error) {
				if len(gradleCodeRE.FindAllString(s, -1)) != 1 || len(gradleNameRE.FindAllString(s, -1)) != 1 {
					return "", fmt.Errorf("expected exactly one versionCode and one versionName literal")
				}
				s = gradleCodeRE.ReplaceAllString(s, fmt.Sprintf("${1}%d", code))
				return gradleNameRE.ReplaceAllString(s, fmt.Sprintf(`${1}"%s"`, v)), nil
			}); err != nil {
				return nil, fmt.Errorf("%s: %w", androidGradle, err)
			}
			changed = append(changed, androidGradle)
		case "luna-desktop":
			if err := editFile(filepath.Join(dir, desktopInfo), func(s string) (string, error) {
				return addMetainfoRelease(s, v.String(), now.UTC().Format("2006-01-02"))
			}); err != nil {
				return nil, fmt.Errorf("%s: %w", desktopInfo, err)
			}
			changed = append(changed, desktopInfo)
		}
		return changed, nil
	}
}

func editFile(path string, f func(string) (string, error)) error {
	b, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	out, err := f(string(b))
	if err != nil {
		return err
	}
	if out == string(b) {
		return nil
	}
	return os.WriteFile(path, []byte(out), 0o644)
}

var releasesOpenRE = regexp.MustCompile(`(?m)^([ \t]*)<releases>[ \t]*\n`)

// addMetainfoRelease puts a <release> entry first in <releases> (newest
// first), unless this version already has one.
func addMetainfoRelease(s, ver, date string) (string, error) {
	if strings.Contains(s, `<release version="`+ver+`"`) {
		return s, nil
	}
	loc := releasesOpenRE.FindStringSubmatchIndex(s)
	if loc == nil {
		return "", fmt.Errorf("no <releases> element on its own line")
	}
	indent := s[loc[2]:loc[3]] + "  "
	entry := fmt.Sprintf("%s<release version=%q date=%q/>\n", indent, ver, date)
	return s[:loc[1]] + entry + s[loc[1]:], nil
}
