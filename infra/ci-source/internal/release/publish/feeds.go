package publish

import (
	"encoding/json"
	"fmt"
	"path"

	"aead.dev/minisign"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/feed"
)

// Channels.
const (
	Stable = "stable"
	Beta   = "beta"
)

// PartSpec describes one downloadable part of a release.
type PartSpec struct {
	Name string // "lunad", "flatpak", ...
	OS   string
	Arch string
	File string
	// Channel limits the part to one feed ("" = every feed this release
	// writes). luna-desktop lists its beta-branch flatpak only in the beta feed
	// by giving the same Name/OS/Arch two specs with different Channel.
	Channel string
	// Version points at an earlier package version that already holds File
	// (luna's OS image is not rebuilt every release). Size and SHA256 must then
	// be given; otherwise the file is in this release's output dir.
	Version string
	Size    int64
	SHA256  string
}

// Release is everything the feeds need to know about one cut.
type Release struct {
	Unit      string
	Version   string
	Channel   string // channel this release is cut on: stable or beta
	Notes     string
	Published string // feed.TimeLayout, fixed for the whole cut
	API       *feed.API
	Parts     []PartSpec
}

// FeedOut is one computed feed.
type FeedOut struct {
	Channel string
	Feed    feed.Feed
}

// FeedPath is the path of a feed inside the feeds branch.
func FeedPath(unit, channel string) string { return path.Join(unit, channel+".json") }

// MarshalFeed renders a feed as the exact bytes that get signed and published.
func MarshalFeed(f feed.Feed) ([]byte, error) {
	b, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}

// BuildFeed makes the feed of one channel. files holds size and hash of the
// files in this release's output dir; urlFor maps (version, file) to a URL.
func BuildFeed(rel Release, channel string, files map[string]FileInfo, urlFor func(version, file string) string) (feed.Feed, error) {
	f := feed.Feed{
		Format: feed.Format, Unit: rel.Unit, Channel: channel, Version: rel.Version,
		Published: rel.Published, Notes: rel.Notes, API: rel.API,
	}
	seen := map[string]bool{}
	for _, p := range rel.Parts {
		if p.Channel != "" && p.Channel != channel {
			continue
		}
		key := p.Name + "|" + p.OS + "|" + p.Arch
		if seen[key] {
			return f, fmt.Errorf("%s feed lists part %s %s/%s twice", channel, p.Name, p.OS, p.Arch)
		}
		seen[key] = true
		ver := rel.Version
		part := feed.Part{Name: p.Name, OS: p.OS, Arch: p.Arch, File: p.File, Size: p.Size, SHA256: p.SHA256}
		if p.Version != "" {
			ver = p.Version
			if p.Size <= 0 || p.SHA256 == "" {
				return f, fmt.Errorf("part %s refers to %s but gives no size and sha256", p.Name, p.Version)
			}
		} else {
			fi, ok := files[p.File]
			if !ok {
				return f, fmt.Errorf("part %s: file %s is not in the output dir", p.Name, p.File)
			}
			part.Size, part.SHA256 = fi.Size, fi.SHA256
		}
		part.URLs = []string{urlFor(ver, p.File)}
		f.Parts = append(f.Parts, part)
	}
	if len(f.Parts) == 0 {
		return f, fmt.Errorf("%s feed has no parts", channel)
	}
	return f, nil
}

// PlanFeeds computes the feeds a release writes. current returns the feed now
// on the feeds branch (nil when there is none). A stable release also writes
// the beta feed when its version is newer than beta's (or beta has no feed
// yet), so beta users move on to the release. Feeds never go backwards:
// an older version or an older `published` is an error. Running it again for
// the same release gives the same answer (resume).
func PlanFeeds(rel Release, files map[string]FileInfo, urlFor func(version, file string) string,
	current func(channel string) (*feed.Feed, error)) ([]FeedOut, error) {
	if !ValidSemver(rel.Version) {
		return nil, fmt.Errorf("version %q is not strict semver", rel.Version)
	}
	if rel.Channel != Stable && rel.Channel != Beta {
		return nil, fmt.Errorf("unknown channel %q", rel.Channel)
	}
	channels := []string{rel.Channel}
	if rel.Channel == Stable {
		channels = append(channels, Beta)
	}
	var out []FeedOut
	for i, ch := range channels {
		cur, err := current(ch)
		if err != nil {
			return nil, err
		}
		if cur != nil {
			c, err := CompareSemver(cur.Version, rel.Version)
			if err != nil {
				return nil, fmt.Errorf("%s feed: %w", ch, err)
			}
			if c > 0 && i == 0 {
				return nil, fmt.Errorf("%s feed is already at %s, newer than %s: feeds never go backwards", ch, cur.Version, rel.Version)
			}
			if c >= 0 && i > 0 {
				continue // beta is already as new (or this is the resume of the same cut)
			}
			if cur.Published > rel.Published {
				return nil, fmt.Errorf("%s feed was published %s, after this release's %s (clock wrong?)", ch, cur.Published, rel.Published)
			}
		}
		f, err := BuildFeed(rel, ch, files, urlFor)
		if err != nil {
			return nil, err
		}
		out = append(out, FeedOut{Channel: ch, Feed: f})
	}
	return out, nil
}

// SignFeeds renders and signs each feed into files for the feeds branch.
func SignFeeds(outs []FeedOut, s Signer) ([]FeedFile, error) {
	var files []FeedFile
	for _, o := range outs {
		b, err := MarshalFeed(o.Feed)
		if err != nil {
			return nil, err
		}
		sig, err := s.Sign(b, FeedComment(o.Feed.Unit, o.Channel, o.Feed.Version, o.Feed.Published))
		if err != nil {
			return nil, fmt.Errorf("sign %s feed: %w", o.Channel, err)
		}
		p := FeedPath(o.Feed.Unit, o.Channel)
		files = append(files, FeedFile{Path: p, Data: b}, FeedFile{Path: p + ".minisig", Data: sig})
	}
	return files, nil
}

// ParseFeed verifies sig over b with pub and decodes the feed (rule 1 first).
func ParseFeed(pub minisign.PublicKey, b, sig []byte) (*feed.Feed, error) {
	if !feed.Verify(pub, b, sig) {
		return nil, fmt.Errorf("feed signature does not verify")
	}
	var f feed.Feed
	if err := json.Unmarshal(b, &f); err != nil {
		return nil, err
	}
	return &f, nil
}
