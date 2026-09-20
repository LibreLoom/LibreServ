package storage

import (
	"testing"
)

func TestEncryptDecryptAESGCM(t *testing.T) {
	key := "0123456789abcdef0123456789abcdef"

	tests := []struct {
		name      string
		plaintext string
	}{
		{"simple password", "my-secret-password"},
		{"empty string", ""},
		{"long credentials", `{"AWS_ACCESS_KEY_ID":"AKIA123","AWS_SECRET_ACCESS_KEY":"secret1234567890"}`},
		{"unicode", "пароль-密码-🔐"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			encrypted, err := encryptAESGCM(tt.plaintext, key)
			if err != nil {
				t.Fatalf("encrypt: %v", err)
			}

			if tt.plaintext != "" && encrypted == tt.plaintext {
				t.Error("ciphertext should differ from plaintext")
			}

			decrypted, err := decryptAESGCM(encrypted, key)
			if err != nil {
				t.Fatalf("decrypt: %v", err)
			}

			if decrypted != tt.plaintext {
				t.Errorf("decrypt mismatch: got %q, want %q", decrypted, tt.plaintext)
			}
		})
	}
}

func TestEncryptAESGCM_WrongKey(t *testing.T) {
	correctKey := "0123456789abcdef0123456789abcdef"
	wrongKey := "fedcba9876543210fedcba9876543210"

	encrypted, err := encryptAESGCM("secret", correctKey)
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}

	_, err = decryptAESGCM(encrypted, wrongKey)
	if err == nil {
		t.Error("expected error when decrypting with wrong key")
	}
}

func TestDecryptAESGCM_InvalidInput(t *testing.T) {
	_, err := decryptAESGCM("not-base64!!!", "key-0123456789abcdef0123456789a")
	if err == nil {
		t.Error("expected error for invalid base64")
	}

	_, err = decryptAESGCM("dG9vLXNob3J0", "key-0123456789abcdef0123456789a")
	if err == nil {
		t.Error("expected error for too-short ciphertext")
	}
}

func TestEncryptAESGCM_DifferentCiphertexts(t *testing.T) {
	key := "0123456789abcdef0123456789abcdef"

	enc1, _ := encryptAESGCM("same-input", key)
	enc2, _ := encryptAESGCM("same-input", key)

	if enc1 == enc2 {
		t.Error("encrypting the same plaintext twice should produce different ciphertexts (random nonce)")
	}

	dec1, _ := decryptAESGCM(enc1, key)
	dec2, _ := decryptAESGCM(enc2, key)

	if dec1 != dec2 {
		t.Error("both should decrypt to the same plaintext")
	}
}
