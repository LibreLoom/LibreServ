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

// DeviceUID is the public, ungrouped identifier printed on a Luna.
func DeviceUID() string {
	return randomCrockford(20)
}

// VerificationCode is the reusable six-hex-character pairing code.
func VerificationCode() string {
	b := make([]byte, 3)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		panic(err)
	}
	const hex = "0123456789ABCDEF"
	out := make([]byte, 6)
	for i, v := range b {
		out[2*i] = hex[v>>4]
		out[2*i+1] = hex[v&0x0f]
	}
	return string(out)
}

// AuthToken is Luna's rolling 256-bit Connect credential.
func AuthToken() string {
	return randomURLToken(32)
}

// SetupGrant is a separate, one-time credential for remote first-Admin setup.
func SetupGrant() string {
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

// NormalizeDeviceUID accepts the grouped display form and returns the
// ungrouped uppercase identifier stored locally and in Connect.
func NormalizeDeviceUID(s string) string {
	return NormalizeToken(s)
}

func IsDeviceUIDShape(norm string) bool {
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

func NormalizeVerificationCode(s string) string {
	return strings.ToUpper(strings.TrimSpace(s))
}

func IsVerificationCodeShape(code string) bool {
	if len(code) != 6 {
		return false
	}
	for _, c := range code {
		if (c < '0' || c > '9') && (c < 'A' || c > 'F') {
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

// DeviceCodePrefix returns the first two Crockford groups (8 chars) of the
// public Device ID. It is an identifier hint, never authentication proof.
func DeviceCodePrefix(normOrGrouped string) string {
	norm := NormalizeToken(normOrGrouped)
	if len(norm) < 8 {
		return ""
	}
	return GroupCrockford(norm[:8])
}
