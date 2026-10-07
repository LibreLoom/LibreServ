package app

import (
	"context"
	"fmt"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/feed"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/release/publish"
)

// Verification is the result of checking one live feed.
type Verification struct {
	Unit    string     `json:"unit"`
	Channel string     `json:"channel"`
	URL     string     `json:"url"`
	Feed    *feed.Feed `json:"feed,omitempty"`
	Err     error      `json:"-"`
	Error   string     `json:"error,omitempty"`
}

// OK reports whether the feed verified.
func (v Verification) OK() bool { return v.Err == nil }

// Verify checks the live feed(s) of a unit: signature against the pinned key
// in keys/, then every URL's size and sha256. An empty channel checks both.
func (a *App) Verify(ctx context.Context, unit, channel string) ([]Verification, error) {
	if _, ok := a.cfg.VersionFiles[unit]; !ok {
		return nil, fmt.Errorf("unknown unit %q", unit)
	}
	chans := []string{publish.Stable, publish.Beta}
	if channel != "" {
		if !validChannel(channel) {
			return nil, fmt.Errorf("channel must be stable or beta, not %q", channel)
		}
		chans = []string{channel}
	}
	pub, err := a.PublicKey(unit)
	if err != nil {
		return nil, err
	}
	var out []Verification
	for _, ch := range chans {
		v := Verification{Unit: unit, Channel: ch, URL: a.feedURL(unit, ch)}
		a.emit.note(unit, "verifying %s", v.URL)
		v.Feed, v.Err = publish.VerifyFeed(ctx, a.cfg.HTTP, v.URL, pub)
		if v.Err != nil {
			v.Error = v.Err.Error()
		}
		out = append(out, v)
	}
	return out, nil
}
