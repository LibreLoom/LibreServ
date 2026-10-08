// Package feed defines the signed release feed (format 1, see
// README.md in this directory) and signs/verifies it with minisign.
package feed

import (
	"bytes"
	"fmt"
	"io"

	"aead.dev/minisign"
)

// Format is the only feed format this package knows.
const Format = 1

// TimeLayout is the exact layout of Feed.Published: UTC, so plain string
// comparison orders it.
const TimeLayout = "2006-01-02T15:04:05Z"

// Feed is one signed release feed: the newest release of one unit on one channel.
type Feed struct {
	Format    int    `json:"format"`
	Unit      string `json:"unit"`
	Channel   string `json:"channel"`
	Version   string `json:"version"`
	Published string `json:"published"`
	Notes     string `json:"notes"`
	Parts     []Part `json:"parts"`
	API       *API   `json:"api,omitempty"`
}

// Part is one downloadable file of a release.
type Part struct {
	Name   string   `json:"name"`
	OS     string   `json:"os"`
	Arch   string   `json:"arch"`
	File   string   `json:"file"`
	Size   int64    `json:"size"`
	SHA256 string   `json:"sha256"`
	URLs   []string `json:"urls"`
}

// API is the compatibility level between units (lunad and its clients).
type API struct {
	Version         int `json:"version"`
	OldestSupported int `json:"oldest_supported"`
}

// Sign signs the exact feed bytes with the prehashed minisign algorithm ("ED",
// what the minisign CLI emits). trustedComment is signed; pass a fixed string
// for reproducible output.
func Sign(priv minisign.PrivateKey, feedBytes []byte, trustedComment string) ([]byte, error) {
	r := minisign.NewReader(bytes.NewReader(feedBytes))
	if _, err := io.Copy(io.Discard, r); err != nil {
		return nil, err
	}
	untrusted := fmt.Sprintf("signature from minisign secret key %X", priv.ID())
	return r.SignWithComments(priv, trustedComment, untrusted), nil
}

// Verify reports whether sig is a valid signature of feedBytes by pub.
func Verify(pub minisign.PublicKey, feedBytes, sig []byte) bool {
	return minisign.Verify(pub, feedBytes, sig)
}
