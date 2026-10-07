package publish

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"time"

	"aead.dev/minisign"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/feed"
)

// Forgejo is the small part of the Forgejo API a cut needs: has the mirror
// delivered a commit yet, and what feed does the raw URL serve.
type Forgejo struct {
	BaseURL string // https://gt.plainskill.net
	Owner   string
	Repo    string
	Token   TokenSource
	HTTP    *http.Client
}

func (f *Forgejo) get(ctx context.Context, u string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return nil, err
	}
	if f.Token != nil {
		tok, err := f.Token.Token()
		if err != nil {
			return nil, fmt.Errorf("forgejo token: %w", err)
		}
		if tok != "" {
			req.Header.Set("Authorization", "token "+tok)
		}
	}
	c := f.HTTP
	if c == nil {
		c = http.DefaultClient
	}
	return c.Do(req)
}

// HasCommit reports whether Forgejo's copy of the repository has the commit.
func (f *Forgejo) HasCommit(ctx context.Context, sha string) (bool, error) {
	u := fmt.Sprintf("%s/api/v1/repos/%s/%s/git/commits/%s", trimSlash(f.BaseURL),
		url.PathEscape(f.Owner), url.PathEscape(f.Repo), url.PathEscape(sha))
	resp, err := f.get(ctx, u)
	if err != nil {
		return false, err
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case 200:
		var c struct {
			SHA string `json:"sha"`
		}
		if json.NewDecoder(resp.Body).Decode(&c) == nil && c.SHA != "" && c.SHA != sha {
			return false, nil
		}
		return true, nil
	case 404, 422:
		return false, nil
	}
	return false, fmt.Errorf("forgejo commit lookup: HTTP %d %s", resp.StatusCode, snippet(resp))
}

// RawFeedURL is where receivers read a feed.
func (f *Forgejo) RawFeedURL(unit, channel string) string {
	return fmt.Sprintf("%s/%s/%s/raw/branch/feeds/%s/%s.json", trimSlash(f.BaseURL),
		url.PathEscape(f.Owner), url.PathEscape(f.Repo), url.PathEscape(unit), url.PathEscape(channel))
}

// RawFeedPublished returns the `published` of the feed the raw URL serves
// ("" when there is none yet).
func (f *Forgejo) RawFeedPublished(ctx context.Context, unit, channel string) (string, error) {
	resp, err := f.get(ctx, f.RawFeedURL(unit, channel))
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 404 {
		return "", nil
	}
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("raw feed: HTTP %d %s", resp.StatusCode, snippet(resp))
	}
	var fd feed.Feed
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&fd); err != nil {
		return "", fmt.Errorf("raw feed: %w", err)
	}
	return fd.Published, nil
}

// MirrorGoal is what a cut waits for on Forgejo.
type MirrorGoal struct {
	Commits   []string          // must all exist on Forgejo
	Published map[string]string // feed channel -> published the raw feed must serve
	Unit      string
}

// WaitMirror polls until Forgejo has every commit and serves the new feeds,
// or the timeout passes.
func (f *Forgejo) WaitMirror(ctx context.Context, g MirrorGoal, every, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	for {
		missing, err := f.mirrorMissing(ctx, g)
		if err == nil && missing == "" {
			return nil
		}
		wait := missing
		if err != nil {
			wait = err.Error()
		}
		select {
		case <-ctx.Done():
			return fmt.Errorf("mirror did not catch up (%s): %w", wait, ctx.Err())
		case <-time.After(every):
		}
	}
}

func (f *Forgejo) mirrorMissing(ctx context.Context, g MirrorGoal) (string, error) {
	for _, sha := range g.Commits {
		ok, err := f.HasCommit(ctx, sha)
		if err != nil {
			return "", err
		}
		if !ok {
			return "commit " + sha[:min(12, len(sha))], nil
		}
	}
	for ch, want := range g.Published {
		got, err := f.RawFeedPublished(ctx, g.Unit, ch)
		if err != nil {
			return "", err
		}
		if got != want {
			return g.Unit + "/" + ch + ".json", nil
		}
	}
	return "", nil
}

// VerifyFeed is `release verify`: it fetches the feed and its signature,
// checks the signature with pub, then downloads every URL of every part and
// checks size and sha256.
func VerifyFeed(ctx context.Context, c *http.Client, feedURL string, pub minisign.PublicKey) (*feed.Feed, error) {
	if c == nil {
		c = http.DefaultClient
	}
	body := func(u string) ([]byte, error) {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
		if err != nil {
			return nil, err
		}
		resp, err := c.Do(req)
		if err != nil {
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("%s: HTTP %d", u, resp.StatusCode)
		}
		return io.ReadAll(io.LimitReader(resp.Body, 1<<24))
	}
	b, err := body(feedURL)
	if err != nil {
		return nil, err
	}
	sig, err := body(feedURL + ".minisig")
	if err != nil {
		return nil, err
	}
	fd, err := ParseFeed(pub, b, sig)
	if err != nil {
		return nil, err
	}
	var errs []error
	for _, p := range fd.Parts {
		for _, u := range p.URLs {
			fi, err := fetchInfo(ctx, c, u)
			switch {
			case err != nil:
				errs = append(errs, fmt.Errorf("part %s: %w", p.Name, err))
			case fi.Size != p.Size || fi.SHA256 != p.SHA256:
				errs = append(errs, fmt.Errorf("part %s: %s does not match the feed (size %d, sha256 %s)", p.Name, u, fi.Size, fi.SHA256))
			}
		}
	}
	return fd, errors.Join(errs...)
}

func fetchInfo(ctx context.Context, c *http.Client, u string) (FileInfo, error) {
	r := &Registry{HTTP: c}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u, nil)
	if err != nil {
		return FileInfo{}, err
	}
	resp, err := r.client().Do(req)
	if err != nil {
		return FileInfo{}, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return FileInfo{}, fmt.Errorf("%s: HTTP %d", u, resp.StatusCode)
	}
	return hashReader(resp.Body)
}
