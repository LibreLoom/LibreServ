package domainname

import (
	"strings"
	"unicode"
)

var reserved = map[string]struct{}{
	"www": {}, "api": {}, "connect": {}, "luna": {}, "admin": {}, "servers": {},
}

func Normalize(name string) string {
	return strings.ToLower(strings.TrimSpace(name))
}

func Validate(name string) string {
	n := Normalize(name)
	if len(n) < 3 || len(n) > 32 {
		return "Pick a name between 3 and 32 letters or numbers."
	}
	if _, ok := reserved[n]; ok {
		return "That name is reserved. Try another."
	}
	if n[0] == '-' || n[len(n)-1] == '-' {
		return "A name cannot start or end with a dash."
	}
	for _, r := range n {
		if unicode.IsLetter(r) || unicode.IsDigit(r) || r == '-' {
			if r > 127 {
				return "Use only letters, numbers, and dashes."
			}
			continue
		}
		return "Use only letters, numbers, and dashes."
	}
	return ""
}

func Hostname(sub, zone string) string {
	return Normalize(sub) + "." + strings.TrimPrefix(zone, ".")
}
