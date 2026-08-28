package security

import (
	"crypto/rand"
	"encoding/hex"
	"io"
	"strings"
	"unicode"
)

// Crockford base32 without I, L, O, U.
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// OfficialBookletToken is a long factory code, grouped for the printed booklet.
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

// OSSHexToken is a one-use setup code for self-built boxes.
// Same strength as official booklet codes (not a short guessable hex).
func OSSHexToken() string {
	return OfficialBookletToken()
}

// FactoryHexToken is a 6-digit uppercase hex code for the LUNAASSETS TOKENS magazine.
func FactoryHexToken() string {
	b := make([]byte, 3)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		panic(err)
	}
	return strings.ToUpper(hex.EncodeToString(b))
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

func IsOSSHex(norm string) bool {
	if len(norm) != 6 {
		return false
	}
	for _, c := range norm {
		if (c < '0' || c > '9') && (c < 'A' || c > 'F') {
			return false
		}
	}
	return true
}

func IsOfficialShape(norm string) bool {
	if len(norm) < 16 || len(norm) > 32 {
		return false
	}
	if IsOSSHex(norm) {
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
