package app

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"

	"aead.dev/minisign"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/feed"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/engine"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
)

// FileSpec is one expected release file: the feed part it becomes (see the
// parts table in RELEASE-PLAN.md) and whether it may be reused from an
// earlier release when this build did not produce it.
type FileSpec struct {
	publish.PartSpec
	// Reuse lets a cut point at the file of an earlier release (luna's os
	// image and installer are not rebuilt every time).
	Reuse bool
	// Attach marks a file that is uploaded with the release (and signed in
	// SHA256SUMS.txt) but is not a feed part. It is optional.
	Attach bool
}

func attach(file string) FileSpec {
	return FileSpec{PartSpec: publish.PartSpec{File: file}, Attach: true}
}

func spec(name, os, arch, file string) FileSpec {
	return FileSpec{PartSpec: publish.PartSpec{Name: name, OS: os, Arch: arch, File: file}}
}

// DefaultFileSpecs is the parts table: what each unit ships.
func DefaultFileSpecs(unit string) []FileSpec {
	switch unit {
	case "sol":
		return []FileSpec{spec("sol", "linux", "amd64", "libreserv-linux-amd64"), spec("sol", "linux", "arm64", "libreserv-linux-arm64")}
	case "sol-connect", "luna-connect":
		return []FileSpec{spec("server", "linux", "amd64", unit+"-server-linux-amd64"), spec("web", "any", "any", unit+"-web.tar.gz")}
	case "luna":
		os, inst := spec("os", "linux", "amd64", "luna-os-x86_64.img.xz"), spec("installer", "linux", "amd64", "luna-rapidinstall-x86_64.iso.xz")
		os.Reuse, inst.Reuse = true, true
		// The .inputs files say what each image was built from, so the next
		// release can tell whether it must be built again.
		return []FileSpec{spec("lunad", "linux", "amd64", "lunad-linux-amd64-musl"), os, inst,
			attach("luna-os-x86_64.img.xz.inputs"), attach("luna-rapidinstall-x86_64.iso.xz.inputs")}
	case "luna-desktop":
		stable, beta := spec("flatpak", "linux", "amd64", "luna-desktop-x86_64.flatpak"), spec("flatpak", "linux", "amd64", "luna-desktop-beta-x86_64.flatpak")
		stable.Channel, beta.Channel = publish.Stable, publish.Beta
		return []FileSpec{stable, beta, spec("windows", "windows", "amd64", "Luna-Desktop-Setup-x86_64.exe")}
	case "luna-android":
		return []FileSpec{spec("apk", "android", "any", "luna-android.apk")}
	}
	return nil
}

// versionDir is dist/<unit>/<version>.
func versionDir(root, unit, ver string) string { return filepath.Join(root, unit, ver) }

// flatten brings the deliverables up from the per-part dirs into root, where
// publish reads one file per part. Hard links when possible (no second copy
// of a multi-GB image). With specs, only the listed files move and the
// missing ones are returned; without, every file in the part dirs does.
func flatten(root string, specs []FileSpec) (missing []string, err error) {
	ents, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	var dirs []string
	for _, e := range ents {
		if e.IsDir() {
			dirs = append(dirs, filepath.Join(root, e.Name()))
		}
	}
	find := func(name string) string {
		for _, d := range dirs {
			p := filepath.Join(d, name)
			if st, err := os.Stat(p); err == nil && st.Mode().IsRegular() {
				return p
			}
		}
		return ""
	}
	place := func(name string) (bool, error) {
		src := find(name)
		dst := filepath.Join(root, name)
		if src == "" {
			st, err := os.Stat(dst)
			return err == nil && st.Mode().IsRegular(), nil
		}
		return true, linkOrCopy(src, dst)
	}
	if len(specs) == 0 {
		seen := map[string]bool{}
		for _, d := range dirs {
			sub, _ := os.ReadDir(d)
			for _, e := range sub {
				if e.Type().IsRegular() && !seen[e.Name()] {
					seen[e.Name()] = true
					if _, err := place(e.Name()); err != nil {
						return nil, err
					}
				}
			}
		}
		return nil, nil
	}
	seen := map[string]bool{}
	for _, s := range specs {
		if seen[s.File] {
			continue
		}
		seen[s.File] = true
		ok, err := place(s.File)
		if err != nil {
			return nil, err
		}
		if !ok && !s.Attach {
			missing = append(missing, s.File)
		}
	}
	return missing, nil
}

func linkOrCopy(src, dst string) error {
	os.Remove(dst)
	if err := os.Link(src, dst); err == nil {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp := dst + ".tmp"
	out, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		os.Remove(tmp)
		return err
	}
	if err := out.Close(); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

// resolveSpecs turns the parts table into the feed parts of a release: the
// files present in outDir, plus the reusable ones taken from an earlier
// release (prior). Every file a feed of this cut needs must be there: a
// stable cut also writes the beta feed, so it needs the beta files too.
func resolveSpecs(unit, channel, outDir string, specs []FileSpec, prior func(name string) (publish.PartSpec, bool)) ([]publish.PartSpec, error) {
	var out []publish.PartSpec
	var missing []string
	for _, s := range specs {
		if s.Attach {
			continue
		}
		needed := s.Channel == "" || s.Channel == channel || (channel == publish.Stable && s.Channel == publish.Beta)
		if st, err := os.Stat(filepath.Join(outDir, s.File)); err == nil && st.Mode().IsRegular() {
			if needed {
				out = append(out, s.PartSpec)
			}
			continue
		}
		if !needed {
			continue
		}
		if s.Reuse && prior != nil {
			if p, ok := prior(s.Name); ok {
				p.Name, p.OS, p.Arch, p.File, p.Channel = s.Name, s.OS, s.Arch, s.File, s.Channel
				out = append(out, p)
				continue
			}
			return nil, fmt.Errorf("%s was not built and no earlier release has one to reuse", s.File)
		}
		missing = append(missing, s.File)
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return nil, fmt.Errorf("the build did not produce: %s", strings.Join(dedupe(missing), ", "))
	}
	return out, nil
}

func dedupe(s []string) []string {
	var out []string
	for i, x := range s {
		if i == 0 || x != s[i-1] {
			out = append(out, x)
		}
	}
	return out
}

// feedLookup reads a unit's live feeds once and shares the answer between the
// preflight, the build and the feed step of one cut. Only "no feed yet" (HTTP
// 404) means there was no earlier release: any other failure (network, 5xx, a
// bad signature, a missing public key) is an error, so a flaky connection can
// never look like "nothing was released" and make a cut rebuild and reflash
// everything.
type feedLookup struct {
	a    *App
	unit string

	once  sync.Once
	feeds map[string]*feed.Feed // channel -> feed; absent when not published yet
	err   error
}

func (a *App) newLookup(unit string) *feedLookup { return &feedLookup{a: a, unit: unit} }

func (l *feedLookup) load(ctx context.Context) (map[string]*feed.Feed, error) {
	l.once.Do(func() {
		l.feeds = map[string]*feed.Feed{}
		pub, err := l.a.PublicKey(l.unit)
		if err != nil {
			l.err = fmt.Errorf("cannot check what %s already released: %w", l.unit, err)
			return
		}
		for _, ch := range []string{publish.Stable, publish.Beta} {
			u := l.a.feedURL(l.unit, ch)
			f, err := l.a.fetchFeed(ctx, u, pub)
			if err != nil {
				l.err = fmt.Errorf("cannot check what %s already released: the %s feed at %s did not load (%s). Nothing was built; check the connection to Forgejo and run the cut again", l.unit, ch, u, l.a.Redact(err.Error()))
				return
			}
			if f != nil {
				l.feeds[ch] = f
			}
		}
	})
	return l.feeds, l.err
}

// released looks up an earlier release's file for a part, in the live feeds
// (newest version wins). Callers load the lookup first and stop on its error;
// when it failed anyway nothing is reported as released.
func (l *feedLookup) released(ctx context.Context) func(name string) (engine.Released, bool) {
	return func(name string) (engine.Released, bool) {
		feeds, err := l.load(ctx)
		if err != nil {
			return engine.Released{}, false
		}
		unit := l.unit
		var best engine.Released
		found := false
		for _, f := range feeds {
			for _, p := range f.Parts {
				if p.Name != name || len(p.URLs) == 0 {
					continue
				}
				v := versionInURL(p.URLs[0], unit, p.File)
				if v == "" {
					continue
				}
				r := engine.Released{Version: v, URL: p.URLs[0], Size: p.Size, SHA256: p.SHA256}
				if !found {
					best, found = r, true
				} else if c, err := publish.CompareSemver(v, best.Version); err == nil && c > 0 {
					best = r
				}
			}
		}
		return best, found
	}
}

// priorPart is released as a PartSpec that points at the earlier file.
func (l *feedLookup) priorPart(ctx context.Context) func(name string) (publish.PartSpec, bool) {
	rel := l.released(ctx)
	return func(name string) (publish.PartSpec, bool) {
		r, ok := rel(name)
		return publish.PartSpec{Version: r.Version, Size: r.Size, SHA256: r.SHA256}, ok
	}
}

// versionInURL extracts <version> from .../generic/<unit>/<version>/<file>.
func versionInURL(u, unit, file string) string {
	pu, err := url.Parse(u)
	if err != nil {
		return ""
	}
	segs := strings.Split(strings.Trim(pu.Path, "/"), "/")
	n := len(segs)
	if n < 3 || segs[n-3] != unit {
		return ""
	}
	v, err1 := url.PathUnescape(segs[n-2])
	f, err2 := url.PathUnescape(segs[n-1])
	if err1 != nil || err2 != nil || f != file || !publish.ValidSemver(v) {
		return ""
	}
	return v
}

// fetchFeed downloads and verifies one feed; a 404 is (nil, nil).
func (a *App) fetchFeed(ctx context.Context, u string, pub minisign.PublicKey) (*feed.Feed, error) {
	get := func(u string) ([]byte, int, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, 0, err
		}
		resp, err := a.cfg.HTTP.Do(req)
		if err != nil {
			return nil, 0, err
		}
		defer resp.Body.Close()
		b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<24))
		return b, resp.StatusCode, err
	}
	b, code, err := get(u)
	if err != nil {
		return nil, err
	}
	if code == http.StatusNotFound {
		return nil, nil
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("%s: HTTP %d", u, code)
	}
	sig, code, err := get(u + ".minisig")
	if err != nil {
		return nil, err
	}
	if code != http.StatusOK {
		return nil, fmt.Errorf("%s.minisig: HTTP %d", u, code)
	}
	return publish.ParseFeed(pub, b, sig)
}

var apiRE = regexp.MustCompile(`pub const (API_VERSION|API_OLDEST_SUPPORTED): u32 = (\d+);`)

// lunaAPI reads lunad's API level from the source at src.
func lunaAPI(ctx context.Context, repo, sha string) (*feed.API, error) {
	out, err := gitShow(ctx, repo, sha, "luna/crates/lunad/src/api/health.rs")
	if err != nil {
		return nil, err
	}
	var api feed.API
	n := 0
	for _, m := range apiRE.FindAllStringSubmatch(out, -1) {
		v, _ := strconv.Atoi(m[2])
		if m[1] == "API_VERSION" {
			api.Version = v
		} else {
			api.OldestSupported = v
		}
		n++
	}
	if n != 2 || api.Version < 1 {
		return nil, fmt.Errorf("cannot read API_VERSION and API_OLDEST_SUPPORTED from lunad's health.rs")
	}
	return &api, nil
}
