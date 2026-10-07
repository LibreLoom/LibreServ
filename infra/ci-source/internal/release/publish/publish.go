// Package publish is the supply side of the release tool (build order step 6):
// SHA256SUMS + signing, the Forgejo generic package registry, the signed feeds
// on the `feeds` branch, the git plumbing around a cut, and the resumable cut
// state machine. See infra/docs/RELEASE-PLAN.md ("Commands" -> cut order).
//
// Nothing here knows how to build a part: the caller hands the cut a Build
// callback that turns the release SHA into an output directory.
package publish

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
	"strings"
)

// Signer signs bytes in minisign's prehashed "ED" form. The secrets package
// plugs in the real keys; tests use MinisignSigner with a generated key.
type Signer interface {
	// Sign returns the complete .minisig file for msg. trustedComment is
	// covered by the signature.
	Sign(msg []byte, trustedComment string) ([]byte, error)
}

// TokenSource hands out the Forgejo token. It is asked for the token on every
// request and the value is only ever put in an Authorization header, never in
// an error or log line.
type TokenSource interface {
	Token() (string, error)
}

// StaticToken is a TokenSource for a fixed value. It prints as "[redacted]".
type StaticToken string

func (t StaticToken) Token() (string, error) { return string(t), nil }
func (t StaticToken) String() string         { return "[redacted]" }
func (t StaticToken) GoString() string       { return "[redacted]" }

// FileInfo is the size and SHA-256 of one output file.
type FileInfo struct {
	Size   int64
	SHA256 string
}

// HashFile returns the size and SHA-256 of the file at path.
func HashFile(path string) (FileInfo, error) {
	f, err := os.Open(path)
	if err != nil {
		return FileInfo{}, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	if err != nil {
		return FileInfo{}, err
	}
	return FileInfo{Size: n, SHA256: hex.EncodeToString(h.Sum(nil))}, nil
}

// --- strict semver 2.0 (no leading v, no leading zeros, no build metadata),
// the same grammar as infra/flatpak-repo/watch.sh.

var semverRE = regexp.MustCompile(`^(0|[1-9][0-9]{0,14})\.(0|[1-9][0-9]{0,14})\.(0|[1-9][0-9]{0,14})(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$`)

// ValidSemver reports whether v is a strict semver version.
func ValidSemver(v string) bool {
	m := semverRE.FindStringSubmatch(v)
	if m == nil {
		return false
	}
	if m[4] != "" {
		for _, id := range strings.Split(m[4], ".") {
			if isNum(id) && (len(id) > 15 || (len(id) > 1 && id[0] == '0')) {
				return false
			}
		}
	}
	return true
}

func isNum(s string) bool {
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return s != ""
}

// CompareSemver returns -1, 0 or 1 for a < b, a == b, a > b.
func CompareSemver(a, b string) (int, error) {
	if !ValidSemver(a) {
		return 0, fmt.Errorf("not a strict semver version: %q", a)
	}
	if !ValidSemver(b) {
		return 0, fmt.Errorf("not a strict semver version: %q", b)
	}
	ma, mb := semverRE.FindStringSubmatch(a), semverRE.FindStringSubmatch(b)
	for i := 1; i <= 3; i++ {
		x, _ := strconv.ParseUint(ma[i], 10, 64)
		y, _ := strconv.ParseUint(mb[i], 10, 64)
		if x != y {
			if x < y {
				return -1, nil
			}
			return 1, nil
		}
	}
	pa, pb := ma[4], mb[4]
	switch {
	case pa == pb:
		return 0, nil
	case pa == "":
		return 1, nil
	case pb == "":
		return -1, nil
	}
	ia, ib := strings.Split(pa, "."), strings.Split(pb, ".")
	for i := 0; i < len(ia) && i < len(ib); i++ {
		x, y := ia[i], ib[i]
		if x == y {
			continue
		}
		nx, ny := isNum(x), isNum(y)
		switch {
		case nx && ny:
			ux, _ := strconv.ParseUint(x, 10, 64)
			uy, _ := strconv.ParseUint(y, 10, 64)
			if ux < uy {
				return -1, nil
			}
			return 1, nil
		case nx:
			return -1, nil
		case ny:
			return 1, nil
		case x < y:
			return -1, nil
		default:
			return 1, nil
		}
	}
	switch {
	case len(ia) < len(ib):
		return -1, nil
	case len(ia) > len(ib):
		return 1, nil
	}
	return 0, nil
}

func hashReader(r io.Reader) (FileInfo, error) {
	h := sha256.New()
	n, err := io.Copy(h, r)
	if err != nil {
		return FileInfo{}, err
	}
	return FileInfo{Size: n, SHA256: hex.EncodeToString(h.Sum(nil))}, nil
}
