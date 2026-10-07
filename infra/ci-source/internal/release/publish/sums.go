package publish

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"

	"aead.dev/minisign"
	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/feed"
)

// Names of the checksum files that ride in every package version.
const (
	SumsName    = "SHA256SUMS.txt"
	SumsSigName = "SHA256SUMS.txt.minisig"
)

// MinisignSigner signs with an in-process minisign private key (prehashed ED).
type MinisignSigner struct{ Key minisign.PrivateKey }

func (s MinisignSigner) Sign(msg []byte, trustedComment string) ([]byte, error) {
	return feed.Sign(s.Key, msg, trustedComment)
}

// SumsComment is the trusted comment on a package version's SHA256SUMS.txt.
func SumsComment(unit, version string) string {
	return fmt.Sprintf("libreserv release %s %s", unit, version)
}

// FeedComment is the trusted comment on a feed signature.
func FeedComment(unit, channel, version, published string) string {
	return fmt.Sprintf("libreserv feed %s %s %s %s", unit, channel, version, published)
}

// OutputFiles lists the regular files directly inside dir (sorted), without
// the checksum files themselves.
func OutputFiles(dir string) ([]string, error) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var names []string
	for _, e := range ents {
		if !e.Type().IsRegular() || e.Name() == SumsName || e.Name() == SumsSigName {
			continue
		}
		names = append(names, e.Name())
	}
	sort.Strings(names)
	return names, nil
}

// Sums renders SHA256SUMS.txt for the files in dir: `<sha256>  <name>` per
// line (sha256sum's text format), sorted by name. Receivers match the name
// field exactly.
func Sums(dir string) (content []byte, files map[string]FileInfo, err error) {
	names, err := OutputFiles(dir)
	if err != nil {
		return nil, nil, err
	}
	if len(names) == 0 {
		return nil, nil, fmt.Errorf("no files to checksum in %s", dir)
	}
	files = make(map[string]FileInfo, len(names))
	var b bytes.Buffer
	for _, n := range names {
		fi, err := HashFile(filepath.Join(dir, n))
		if err != nil {
			return nil, nil, err
		}
		files[n] = fi
		fmt.Fprintf(&b, "%s  %s\n", fi.SHA256, n)
	}
	return b.Bytes(), files, nil
}

// WriteSigned writes SHA256SUMS.txt and SHA256SUMS.txt.minisig into dir and
// returns the per-file info. Deterministic: same files, same bytes.
func WriteSigned(dir, unit, version string, s Signer) (map[string]FileInfo, error) {
	content, files, err := Sums(dir)
	if err != nil {
		return nil, err
	}
	sig, err := s.Sign(content, SumsComment(unit, version))
	if err != nil {
		return nil, fmt.Errorf("sign %s: %w", SumsName, err)
	}
	if err := os.WriteFile(filepath.Join(dir, SumsName), content, 0o644); err != nil {
		return nil, err
	}
	if err := os.WriteFile(filepath.Join(dir, SumsSigName), sig, 0o644); err != nil {
		return nil, err
	}
	return files, nil
}
