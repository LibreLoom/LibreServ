package security

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math/big"
	"time"
)

// GenerateToken creates a cryptographically random token with a prefix.
func GenerateToken(prefix string) string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return fmt.Sprintf("%s_%s", prefix, hex.EncodeToString(b))
}

// GenerateID creates a unique ID with a prefix and timestamp.
func GenerateID(prefix string) string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return fmt.Sprintf("%s_%d_%s", prefix, time.Now().Unix(), hex.EncodeToString(b))
}

// RandomHex returns n bytes of random hex (2n hex chars).
func RandomHex(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// RandomPassword generates a random alphanumeric password of length n.
func RandomPassword(n int) string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	max := big.NewInt(int64(len(chars)))
	for i := range b {
		idx, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic("crypto/rand failed: " + err.Error())
		}
		b[i] = chars[idx.Int64()]
	}
	return string(b)
}

// RandomString generates a random alphanumeric string of length n (no crypto requirement).
func RandomString(n int) string {
	return RandomPassword(n)
}

// GenerateConnectKey creates a human-readable Connect key in the format XXXX-XXXX-XXXX-XXXX.
func GenerateConnectKey() string {
	const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" // no I, O, 0, 1 to avoid confusion
	b := make([]byte, 16)
	max := big.NewInt(int64(len(chars)))
	for i := range b {
		idx, err := rand.Int(rand.Reader, max)
		if err != nil {
			panic("crypto/rand failed: " + err.Error())
		}
		b[i] = chars[idx.Int64()]
	}
	return fmt.Sprintf("%s-%s-%s-%s", string(b[0:4]), string(b[4:8]), string(b[8:12]), string(b[12:16]))
}
