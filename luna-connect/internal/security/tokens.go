package security

import (
	"crypto/rand"
	"io"
	"strings"
	"unicode"
)

// Crockford base32 without I, L, O, U.
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// OfficialBookletToken is a long factory setup code for Lunas purchased from LibreLoom
// (grouped Crockford; same shape as website setup codes).
func OfficialBookletToken() string {
	raw := randomCrockford(20)
	return GroupCrockford(raw)
}

func randomCrockford(n int) string {
	b := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		panic(err)
	}
	out := make([]byte, n)
	for i := 0; i < n; i++ {
		out[i] = crockford[int(b[i])%len(crockford)]
	}
	return string(out)
}

func GroupCrockford(raw string) string {
	raw = NormalizeToken(raw)
	var parts []string
	for i := 0; i < len(raw); i += 4 {
		end := i + 4
		if end > len(raw) {
			end = len(raw)
		}
		parts = append(parts, raw[i:end])
	}
	return strings.Join(parts, "-")
}

// WebsiteSetupToken is a one-use setup code for self-built boxes (same format as official).
func WebsiteSetupToken() string {
	return OfficialBookletToken()
}

// NormalizeToken strips grouping and maps lookalike Crockford letters.
func NormalizeToken(s string) string {
	s = strings.TrimSpace(s)
	var b strings.Builder
	for _, r := range s {
		if r == '-' || r == ' ' || r == '_' {
			continue
		}
		r = unicode.ToUpper(r)
		switch r {
		case 'I', 'L':
			r = '1'
		case 'O':
			r = '0'
		}
		b.WriteRune(r)
	}
	return b.String()
}

func IsOfficialShape(norm string) bool {
	if len(norm) < 16 || len(norm) > 32 {
		return false
	}
	for _, c := range norm {
		if !strings.ContainsRune(crockford, c) {
			return false
		}
	}
	return true
}

// TokenHint returns a short uppercase suffix for admin lists (plaintext is not stored).
func TokenHint(norm string) string {
	norm = NormalizeToken(norm)
	if norm == "" {
		return ""
	}
	if len(norm) <= 4 {
		return norm
	}
	return "…" + norm[len(norm)-4:]
}

// SetupPrefix returns the first two Crockford groups (8 chars) used to unlock
// remote Luna setup. Empty if the normalized code is too short.
func SetupPrefix(normOrGrouped string) string {
	norm := NormalizeToken(normOrGrouped)
	if len(norm) < 8 {
		return ""
	}
	return GroupCrockford(norm[:8])
}

// SetupPrefixNorm returns the ungrouped 8-char prefix for constant-time compare.
func SetupPrefixNorm(normOrGrouped string) string {
	norm := NormalizeToken(normOrGrouped)
	if len(norm) < 8 {
		return ""
	}
	return norm[:8]
}
