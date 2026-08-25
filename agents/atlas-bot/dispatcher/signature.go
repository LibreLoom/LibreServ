package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"strings"
)

func verifySignature(secret string, body []byte, r *http.Request) bool {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	sum := hex.EncodeToString(mac.Sum(nil))
	candidates := []string{
		r.Header.Get("X-Forgejo-Signature"),
		r.Header.Get("X-Gitea-Signature"),
	}
	if hub := r.Header.Get("X-Hub-Signature-256"); strings.HasPrefix(hub, "sha256=") {
		candidates = append(candidates, strings.TrimPrefix(hub, "sha256="))
	}
	ok := false
	for _, c := range candidates {
		if c == "" {
			continue
		}
		if hmac.Equal([]byte(strings.ToLower(c)), []byte(sum)) {
			ok = true
		}
	}
	return ok
}
