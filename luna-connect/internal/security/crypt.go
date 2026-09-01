package security

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"strings"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/config"
)

const sealedPrefix = "v1:"

// AtRestReady reports whether secrets can be encrypted at rest (production requires server.at_rest_key).
func AtRestReady() error {
	_, err := atRestKey()
	return err
}

func atRestKey() ([]byte, error) {
	raw := strings.TrimSpace(config.C.Server.AtRestKey)
	if raw == "" {
		if !config.DevMode() {
			return nil, fmt.Errorf("missing at-rest key")
		}
		sum := sha256.Sum256([]byte("lunaconnect-dev-at-rest-key"))
		return sum[:], nil
	}
	if b, err := hex.DecodeString(raw); err == nil && (len(b) == 16 || len(b) == 24 || len(b) == 32) {
		return b, nil
	}
	sum := sha256.Sum256([]byte(raw))
	return sum[:], nil
}

func SealString(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}
	key, err := atRestKey()
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	out := gcm.Seal(nonce, nonce, []byte(plain), nil)
	return sealedPrefix + hex.EncodeToString(out), nil
}

func OpenString(blob string) (string, error) {
	if blob == "" {
		return "", nil
	}
	if !strings.HasPrefix(blob, sealedPrefix) {
		if config.DevMode() {
			return blob, nil
		}
		return "", fmt.Errorf("invalid secret")
	}
	key, err := atRestKey()
	if err != nil {
		return "", err
	}
	raw, err := hex.DecodeString(strings.TrimPrefix(blob, sealedPrefix))
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	ns := gcm.NonceSize()
	if len(raw) < ns {
		return "", fmt.Errorf("invalid secret")
	}
	plain, err := gcm.Open(nil, raw[:ns], raw[ns:], nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}
