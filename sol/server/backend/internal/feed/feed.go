// Package feed implements the signed update feed (format 1) described in
// infra/ci-source/internal/feed/README.md. A receiver verifies the feed's minisign
// signature over the exact bytes, applies the rules in a fixed order, and only
// then downloads and checks the chosen part.
package feed

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"aead.dev/minisign"
	"github.com/Masterminds/semver/v3"
)

// Rejections. Reason() gives the short names used by the shared fixtures.
var (
	ErrBadSignature   = errors.New("the update list could not be verified")
	ErrBadFeed        = errors.New("the update list could not be read")
	ErrUnknownFormat  = errors.New("the update list is in a format this version does not understand")
	ErrWrongUnit      = errors.New("the update list is for a different product")
	ErrWrongChannel   = errors.New("the update list is for a different channel")
	ErrReplayed       = errors.New("the update list is older than one already seen")
	ErrMissingPart    = errors.New("the update list has no file for this computer")
	ErrBadVersion     = errors.New("a version number is not valid")
	ErrSizeMismatch   = errors.New("the downloaded file is not the expected size")
	ErrShaMismatch    = errors.New("the downloaded file did not match its checksum")
	ErrAllURLsFailed  = errors.New("the update file could not be downloaded")
	errNoKeys         = errors.New("no trusted keys")
	maxDownloadHeader = int64(1) << 40
)

// Reason returns the short fixture name for an error ("" if unknown).
func Reason(err error) string {
	switch {
	case errors.Is(err, ErrBadSignature):
		return "bad-signature"
	case errors.Is(err, ErrWrongUnit):
		return "wrong-unit"
	case errors.Is(err, ErrWrongChannel):
		return "wrong-channel"
	case errors.Is(err, ErrUnknownFormat):
		return "unknown-format"
	case errors.Is(err, ErrReplayed):
		return "replayed"
	case errors.Is(err, ErrMissingPart):
		return "missing-part"
	case errors.Is(err, ErrSizeMismatch):
		return "size-mismatch"
	case errors.Is(err, ErrShaMismatch):
		return "sha-mismatch"
	case errors.Is(err, ErrAllURLsFailed):
		return "all-urls-failed"
	}
	return ""
}

// Part is one downloadable file.
type Part struct {
	Name   string   `json:"name"`
	OS     string   `json:"os"`
	Arch   string   `json:"arch"`
	File   string   `json:"file"`
	Size   int64    `json:"size"`
	SHA256 string   `json:"sha256"`
	URLs   []string `json:"urls"`
}

// Feed is a parsed format 1 feed. Unknown fields are ignored.
type Feed struct {
	Format    int    `json:"format"`
	Unit      string `json:"unit"`
	Channel   string `json:"channel"`
	Version   string `json:"version"`
	Published string `json:"published"`
	Notes     string `json:"notes"`
	Parts     []Part `json:"parts"`
}

// Request is what the receiver asks for.
type Request struct {
	Unit                string
	Channel             string
	OS                  string
	Arch                string
	Part                string
	InstalledVersion    string
	NewestPublishedSeen string // "" = none
}

// Result is a feed that passed every rule.
type Result struct {
	Feed *Feed
	Part *Part
	// Update is true when the feed's version is strictly newer than installed.
	Update bool
}

// ParseVersion parses a strict semver 2.0 version (no "v", no leading zeros).
func ParseVersion(s string) (*semver.Version, error) {
	v, err := semver.StrictNewVersion(s)
	if err != nil {
		return nil, fmt.Errorf("%w: %q", ErrBadVersion, s)
	}
	return v, nil
}

// Verify checks sig over the exact body with any of the keys.
func Verify(keys []minisign.PublicKey, body, sig []byte) error {
	if len(keys) == 0 {
		return fmt.Errorf("%w: %v", ErrBadSignature, errNoKeys)
	}
	for _, pk := range keys {
		if minisign.Verify(pk, body, sig) {
			return nil
		}
	}
	return ErrBadSignature
}

// Check applies the rules in order: signature, parse, format, unit, channel,
// replay, part selection, version comparison.
func Check(keys []minisign.PublicKey, body, sig []byte, req Request) (*Result, error) {
	if err := Verify(keys, body, sig); err != nil {
		return nil, err
	}
	var head struct {
		Format int `json:"format"`
	}
	if err := json.Unmarshal(body, &head); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadFeed, err)
	}
	if head.Format != 1 {
		return nil, ErrUnknownFormat
	}
	var f Feed
	if err := json.Unmarshal(body, &f); err != nil {
		return nil, fmt.Errorf("%w: %v", ErrBadFeed, err)
	}
	if f.Unit != req.Unit {
		return nil, ErrWrongUnit
	}
	if f.Channel != req.Channel {
		return nil, ErrWrongChannel
	}
	// "published" is exactly YYYY-MM-DDTHH:MM:SSZ, so string order is time order.
	if req.NewestPublishedSeen != "" && f.Published < req.NewestPublishedSeen {
		return nil, ErrReplayed
	}
	var part *Part
	for i := range f.Parts {
		p := &f.Parts[i]
		if p.Name == req.Part && (p.OS == req.OS || p.OS == "any") && (p.Arch == req.Arch || p.Arch == "any") {
			part = p
			break
		}
	}
	if part == nil {
		return nil, ErrMissingPart
	}
	installed, err := ParseVersion(req.InstalledVersion)
	if err != nil {
		return nil, err
	}
	latest, err := ParseVersion(f.Version)
	if err != nil {
		return nil, err
	}
	return &Result{Feed: &f, Part: part, Update: latest.GreaterThan(installed)}, nil
}

// Download tries part.URLs in order and writes the first file that matches
// part.Size and part.SHA256 to dest (created 0755, fsynced). Reading stops one
// byte past Size. On any failure dest is removed.
func Download(ctx context.Context, client *http.Client, part *Part, dest string) error {
	var integrity error
	for _, u := range part.URLs {
		err := downloadOne(ctx, client, u, part, dest)
		if err == nil {
			return nil
		}
		_ = os.Remove(dest)
		if errors.Is(err, ErrSizeMismatch) || errors.Is(err, ErrShaMismatch) {
			integrity = err
		}
		if ctx.Err() != nil {
			return ctx.Err()
		}
	}
	if integrity != nil {
		return integrity
	}
	return ErrAllURLsFailed
}

func downloadOne(ctx context.Context, client *http.Client, url string, part *Part, dest string) error {
	if part.Size < 0 || part.Size > maxDownloadHeader {
		return ErrSizeMismatch
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download returned status %d", resp.StatusCode)
	}
	out, err := os.OpenFile(dest, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(out, h), io.LimitReader(resp.Body, part.Size+1))
	if err != nil {
		_ = out.Close()
		return err
	}
	if n != part.Size {
		_ = out.Close()
		return ErrSizeMismatch
	}
	if !strings.EqualFold(hex.EncodeToString(h.Sum(nil)), part.SHA256) {
		_ = out.Close()
		return ErrShaMismatch
	}
	if err := out.Sync(); err != nil {
		_ = out.Close()
		return err
	}
	return out.Close()
}

// SumsLookup returns the hash on the line of a SHA256SUMS file whose file
// name field equals name exactly (a leading "*" binary marker is allowed).
func SumsLookup(sums []byte, name string) (string, bool) {
	for _, line := range bytes.Split(sums, []byte("\n")) {
		fields := strings.Fields(string(line))
		if len(fields) != 2 {
			continue
		}
		if strings.TrimPrefix(fields[1], "*") == name {
			return fields[0], true
		}
	}
	return "", false
}
