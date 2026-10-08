package system

import (
	_ "embed"
	"strings"

	"aead.dev/minisign"
)

// pinnedPubFile is the Sol release trust root. Keep identical to
// keys/sol.minisign.pub (enforced by TestPinnedKeyMatchesRepoFile).
//
//go:embed releases.minisign.pub
var pinnedPubFile string

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

func (c *UpdateChecker) pinned() []minisign.PublicKey {
	if len(c.pinnedKeys) > 0 {
		return c.pinnedKeys
	}
	return defaultPinnedKeys()
}
