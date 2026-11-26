package security

import (
	"crypto/rand"
	"encoding/base64"
	"io"
	"strings"
	"unicode"
)

// Crockford base32 without I, L, O, U.
const crockford = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

// DeviceToken is the single 20-character Crockford token that identifies a
// Luna, pairs it to an account, and proves an off-LAN first-Admin setup. Only
// its hash is stored by Connect, so it is shown once, when it is minted.
func DeviceToken() string {
	return randomCrockford(20)
}

// AuthToken is Luna's rolling 256-bit Connect credential.
func AuthToken() string {
	return randomURLToken(32)
}

func randomURLToken(n int) string {
	b := make([]byte, n)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// ValidAuthToken reports whether token is an unpadded base64url encoding of
// exactly 32 bytes. Shape validation keeps legacy Crockford bearer tokens out
// before any database lookup.
func ValidAuthToken(token string) bool {
	if token == "" || strings.ContainsAny(token, "=+/") {
		return false
	}
	b, err := base64.RawURLEncoding.DecodeString(token)
	return err == nil && len(b) == 32
}

func randomCrockford(n int) string {
	// Rejection sampling avoids the modulo bias of mapping each byte directly
	// into the 32-character alphabet.
	const limit = 256 - (256 % len(crockford))
	buf := make([]byte, n*2)
	out := make([]byte, 0, n)
	for len(out) < n {
		if _, err := io.ReadFull(rand.Reader, buf); err != nil {
			panic(err)
		}
		for _, b := range buf {
			if int(b) >= limit {
				continue
			}
			out = append(out, crockford[int(b)%len(crockford)])
			if len(out) == n {
				break
			}
		}
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

// NormalizeDeviceToken accepts the grouped display form and returns the
// ungrouped uppercase token that is hashed and compared.
func NormalizeDeviceToken(s string) string {
	return NormalizeToken(s)
}

// IsDeviceTokenShape reports whether norm is 20 Crockford characters.
func IsDeviceTokenShape(norm string) bool {
	if len(norm) != 20 {
		return false
	}
	for _, c := range norm {
		if !strings.ContainsRune(crockford, c) {
			return false
		}
	}
	return true
}

// TokenHint returns a short uppercase suffix for admin lists.
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
