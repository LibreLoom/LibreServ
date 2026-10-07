package app

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"os/exec"
	"strings"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/version"
)

// RepoStatus is the checkout's state, for headers.
type RepoStatus struct {
	Branch string
	SHA    string // short
	Clean  bool
	Err    string
}

// RepoStatus reads the branch, short commit and whether the tree is clean.
func (a *App) RepoStatus(ctx context.Context) RepoStatus {
	run := func(args ...string) (string, error) {
		cmd := exec.CommandContext(ctx, "git", append([]string{"-C", a.cfg.Repo}, args...)...)
		var out, errb bytes.Buffer
		cmd.Stdout, cmd.Stderr = &out, &errb
		if err := cmd.Run(); err != nil {
			return "", fmt.Errorf("git %s: %s", args[0], strings.TrimSpace(errb.String()))
		}
		return strings.TrimSpace(out.String()), nil
	}
	var s RepoStatus
	var err error
	if s.Branch, err = run("rev-parse", "--abbrev-ref", "HEAD"); err != nil {
		s.Err = err.Error()
		return s
	}
	if s.SHA, err = run("rev-parse", "--short=7", "HEAD"); err != nil {
		s.Err = err.Error()
		return s
	}
	st, err := run("status", "--porcelain", "--untracked-files=no")
	s.Clean = err == nil && st == ""
	return s
}

// UnitStatus is one unit's local state.
type UnitStatus struct {
	Unit    string
	Version string // the VERSION file
	LastTag string // "" when never tagged
	Since   int    // commits since LastTag (or in all history); -1 unknown
	Err     string
}

// UnitStatuses reports every unit that has a VERSION file, in Units() order.
func (a *App) UnitStatuses(ctx context.Context) []UnitStatus {
	var out []UnitStatus
	for _, u := range a.cfg.Units() {
		if _, ok := a.cfg.VersionFiles[u]; !ok {
			continue
		}
		s := UnitStatus{Unit: u, Since: -1}
		if v, err := a.currentVersion(u); err != nil {
			s.Err = err.Error()
		} else {
			s.Version = v.String()
		}
		if tag, _, ok, err := version.NotesBase(ctx, a.cfg.Repo, u, "HEAD"); err == nil {
			s.LastTag = tag
			if n, err := version.CommitsSince(ctx, a.cfg.Repo, tag, "HEAD"); err == nil {
				s.Since = n
			}
			_ = ok
		}
		out = append(out, s)
	}
	return out
}

// FeedHead is what a unit's live feed on one channel says.
type FeedHead struct {
	Unit      string
	Channel   string
	Version   string
	Published time.Time
	// Err is set when the feed is missing, unreachable or its signature is
	// wrong; Missing is true for a plain 404 (never published).
	Err     string
	Missing bool
}

// FeedHeads fetches both channel feeds of a unit and checks their signature
// (not every file: that is Verify). Meant for background refreshes.
func (a *App) FeedHeads(ctx context.Context, unit string) []FeedHead {
	pub, perr := a.PublicKey(unit)
	var out []FeedHead
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, ch := range []string{publish.Stable, publish.Beta} {
		h := FeedHead{Unit: unit, Channel: ch}
		wg.Add(1)
		go func() {
			defer wg.Done()
			if perr != nil {
				h.Err = perr.Error()
			} else {
				cctx, cancel := context.WithTimeout(ctx, 10*time.Second)
				defer cancel()
				u := a.feedURL(unit, ch)
				b, code, err := a.fetch(cctx, u)
				switch {
				case code == http.StatusNotFound:
					h.Missing = true
				case err != nil:
					h.Err = err.Error()
				default:
					sig, _, err := a.fetch(cctx, u+".minisig")
					if err != nil {
						h.Err = "no signature: " + err.Error()
						break
					}
					fd, err := publish.ParseFeed(pub, b, sig)
					if err != nil {
						h.Err = err.Error()
						break
					}
					h.Version = fd.Version
					h.Published, _ = time.Parse(time.RFC3339, fd.Published)
				}
			}
			mu.Lock()
			out = append(out, h)
			mu.Unlock()
		}()
	}
	wg.Wait()
	if len(out) == 2 && out[0].Channel != publish.Stable {
		out[0], out[1] = out[1], out[0]
	}
	return out
}

func (a *App) fetch(ctx context.Context, url string) ([]byte, int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, 0, err
	}
	resp, err := a.cfg.HTTP.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, resp.StatusCode, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<24))
	return b, resp.StatusCode, err
}

// BumpPreview is a version a bump kind would produce.
type BumpPreview struct {
	Kind        string
	Version     string
	VersionCode int // Android versionCode, 0 when not relevant
	Err         string
}

// BumpPreviews lists what each bump kind makes of the unit's current
// version on a channel. Kinds that the channel cannot take carry an Err.
func (a *App) BumpPreviews(unit, channel string) []BumpPreview {
	var out []BumpPreview
	for _, k := range []string{version.BumpPatch, version.BumpMinor, version.BumpMajor, version.BumpBeta} {
		p := BumpPreview{Kind: k}
		_, next, err := a.CutVersion(CutRequest{Unit: unit, Channel: channel, Bump: k})
		if err != nil {
			p.Err = err.Error()
		} else {
			p.Version = next.String()
			if unit == "luna-android" {
				if c, err := next.AndroidVersionCode(); err == nil {
					p.VersionCode = c
				}
			}
		}
		out = append(out, p)
	}
	return out
}

// AndroidVersionCode computes the versionCode of an explicit version string.
func AndroidVersionCode(v string) (int, error) {
	pv, err := version.Parse(v)
	if err != nil {
		return 0, err
	}
	return pv.AndroidVersionCode()
}
