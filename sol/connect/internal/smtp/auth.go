package smtp

import "encoding/base64"

// base64Decode decodes a base64 string, returning an error if invalid.
func base64Decode(s string) (string, error) {
	b, err := base64.StdEncoding.DecodeString(s)
	if err != nil {
		return "", err
	}
	return string(b), nil
}
