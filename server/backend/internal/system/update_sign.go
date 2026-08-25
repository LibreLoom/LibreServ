package system

import (
	_ "embed"
	"errors"
	"fmt"
	"io"
	"net/http"
	"runtime"
	"strings"

	"aead.dev/minisign"
)

//go:embed releases.minisign.pub
var pinnedPubFile string

var (
	// ErrMissingChecksum is returned when SHA256SUMS.txt is absent.
	ErrMissingChecksum = errors.New("that update is missing a checksum file. nothing was installed")
	// ErrMissingSignature is returned when SHA256SUMS.txt.minisig is absent.
	ErrMissingSignature = errors.New("that update is missing its signature. nothing was installed")
	// ErrBadSignature is returned when the minisign signature does not match a pinned key.
	ErrBadSignature = errors.New("that update could not be verified. nothing was installed")
	// ErrChecksumMismatch is returned when the binary hash does not match the signed checksums file.
	ErrChecksumMismatch = errors.New("that update file didn't match its checksum. nothing was installed")
)

func parseMinisignPub(text string) []minisign.PublicKey {
	var keys []minisign.PublicKey
	for line := range strings.SplitSeq(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "untrusted comment") || !strings.HasPrefix(line, "RW") {
			continue
		}
		var pk minisign.PublicKey
		if err := pk.UnmarshalText([]byte(line)); err != nil {
			continue
		}
		keys = append(keys, pk)
	}
	return keys
}

func defaultPinnedKeys() []minisign.PublicKey {
	return parseMinisignPub(pinnedPubFile)
}

func verifySumsSignature(keys []minisign.PublicKey, sums, sig []byte) error {
	if len(keys) == 0 {
		return ErrBadSignature
	}
	for _, pk := range keys {
		if minisign.Verify(pk, sums, sig) {
			return nil
		}
	}
	return ErrBadSignature
}

func checksumLineForBinary(sums []byte, binaryName string) (string, error) {
	for line := range strings.SplitSeq(string(sums), "\n") {
		parts := strings.Fields(line)
		if len(parts) >= 2 && strings.Contains(parts[1], binaryName) {
			return strings.TrimSpace(parts[0]), nil
		}
	}
	return "", ErrMissingChecksum
}

func (c *UpdateChecker) pinned() []minisign.PublicKey {
	if len(c.pinnedKeys) > 0 {
		return c.pinnedKeys
	}
	return defaultPinnedKeys()
}

func (c *UpdateChecker) getBytes(url string) (int, []byte, error) {
	resp, err := c.client.Get(url)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = resp.Body.Close() }()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return resp.StatusCode, nil, err
	}
	return resp.StatusCode, body, nil
}

func (c *UpdateChecker) fetchSignedChecksum(tagName string) (string, error) {
	binaryName := fmt.Sprintf("libreserv-%s-%s", runtime.GOOS, runtime.GOARCH)
	sumsURL := fmt.Sprintf("%s/download/%s/SHA256SUMS.txt", c.downloadBaseURL(), tagName)
	sigURL := fmt.Sprintf("%s/download/%s/SHA256SUMS.txt.minisig", c.downloadBaseURL(), tagName)

	status, sums, err := c.getBytes(sumsURL)
	if err != nil {
		return "", ErrMissingChecksum
	}
	if status != http.StatusOK {
		return "", ErrMissingChecksum
	}
	status, sig, err := c.getBytes(sigURL)
	if err != nil {
		return "", ErrMissingSignature
	}
	if status != http.StatusOK {
		return "", ErrMissingSignature
	}
	if err := verifySumsSignature(c.pinned(), sums, sig); err != nil {
		return "", err
	}
	return checksumLineForBinary(sums, binaryName)
}
