package oidc

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"database/sql"
	"encoding/pem"
	"errors"
	"fmt"
	"io"

	jose "github.com/go-jose/go-jose/v4"
	"github.com/google/uuid"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func isNotFound(err error) bool {
	return errors.Is(err, sql.ErrNoRows)
}

// EnsureSigningKey returns the current RSA signing key for OIDC token signing.
//
// On first call (no existing key in DB), it generates a 2048-bit RSA key,
// encrypts the private key PEM with AES-GCM using the cloud encryption key,
// and persists it in the oidc_signing_keys table with is_current=1.
//
// On subsequent calls, it loads and decrypts the current key from the DB.
func EnsureSigningKey(db *database.DB, encryptionKey string) (*signingKey, error) {
	sqlDB := db.SQL()

	var keyID, publicPEM, algo string
	var encryptedPEM []byte
	err := sqlDB.QueryRowContext(context.Background(),
		`SELECT id, key_pem, public_pem, algorithm FROM oidc_signing_keys WHERE is_current = 1`,
	).Scan(&keyID, &encryptedPEM, &publicPEM, &algo)

	if err == nil {
		privatePEM, err := decryptPEM(encryptedPEM, encryptionKey)
		if err != nil {
			return nil, fmt.Errorf("failed to decrypt signing key: %w", err)
		}
		key, err := parsePrivateKey(privatePEM)
		if err != nil {
			return nil, fmt.Errorf("failed to parse private key: %w", err)
		}
		return &signingKey{
			id:        keyID,
			algorithm: jose.SignatureAlgorithm(algo),
			privKey:   key,
		}, nil
	}

	if err != nil && !isNotFound(err) {
		return nil, fmt.Errorf("query signing keys: %w", err)
	}

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("generate rsa key: %w", err)
	}

	newKeyID := uuid.NewString()
	newPublicPEM, err := encodePublicKey(key)
	if err != nil {
		return nil, fmt.Errorf("encode public key: %w", err)
	}

	privatePEM, err := encodePrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("encode private key: %w", err)
	}

	encryptedPEM, err = encryptPEM(privatePEM, encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("encrypt private key: %w", err)
	}

	_, err = sqlDB.ExecContext(context.Background(),
		`INSERT INTO oidc_signing_keys (id, key_pem, public_pem, algorithm, is_current)
		 VALUES (?, ?, ?, 'RS256', 1)`,
		newKeyID, encryptedPEM, newPublicPEM,
	)
	if err != nil {
		return nil, fmt.Errorf("insert signing key: %w", err)
	}

	return &signingKey{
		id:        newKeyID,
		algorithm: jose.RS256,
		privKey:   key,
	}, nil
}

// GetAllSigningKeys returns all public keys from the database (for key rotation).
func GetAllSigningKeys(db *database.DB) ([]*publicKey, error) {
	sqlDB := db.SQL()

	rows, err := sqlDB.QueryContext(context.Background(),
		`SELECT id, public_pem, algorithm FROM oidc_signing_keys ORDER BY created_at`,
	)
	if err != nil {
		return nil, fmt.Errorf("query signing keys: %w", err)
	}
	defer rows.Close()

	var keys []*publicKey
	for rows.Next() {
		var keyID, algo string
		var pubDER []byte
		if err := rows.Scan(&keyID, &pubDER, &algo); err != nil {
			return nil, fmt.Errorf("scan signing key: %w", err)
		}
		pubKey, err := parseRSAPublicKey(pubDER)
		if err != nil {
			return nil, fmt.Errorf("parse public key %s: %w", keyID, err)
		}
		keys = append(keys, &publicKey{
			id:        keyID,
			algorithm: jose.SignatureAlgorithm(algo),
			pubKey:    pubKey,
		})
	}
	return keys, rows.Err()
}

// RotateSigningKey creates a new RSA key and marks the current one as non-current.
// The whole operation runs in a single transaction and the old key is only
// demoted AFTER the new key is inserted, so there is never a window with zero
// current keys (and the single-current unique index is never violated).
func RotateSigningKey(db *database.DB, encryptionKey string) (*signingKey, error) {
	sqlDB := db.SQL()

	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, fmt.Errorf("generate rsa key: %w", err)
	}

	newKeyID := uuid.NewString()
	newPublicPEM, err := encodePublicKey(key)
	if err != nil {
		return nil, fmt.Errorf("encode public key: %w", err)
	}

	privatePEM, err := encodePrivateKey(key)
	if err != nil {
		return nil, fmt.Errorf("encode private key: %w", err)
	}

	encryptedPEM, err := encryptPEM(privatePEM, encryptionKey)
	if err != nil {
		return nil, fmt.Errorf("encrypt private key: %w", err)
	}

	tx, err := sqlDB.BeginTx(context.Background(), nil)
	if err != nil {
		return nil, fmt.Errorf("begin rotation tx: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	// Demote the old current key, then insert the new one — both inside one
	// transaction so concurrent readers (and the single-current unique index)
	// never observe a zero-current or two-current window.
	if _, err := tx.ExecContext(context.Background(),
		`UPDATE oidc_signing_keys SET is_current = 0 WHERE is_current = 1`,
	); err != nil {
		return nil, fmt.Errorf("update current keys: %w", err)
	}

	if _, err := tx.ExecContext(context.Background(),
		`INSERT INTO oidc_signing_keys (id, key_pem, public_pem, algorithm, is_current)
		 VALUES (?, ?, ?, 'RS256', 1)`,
		newKeyID, encryptedPEM, newPublicPEM,
	); err != nil {
		return nil, fmt.Errorf("insert signing key: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit rotation tx: %w", err)
	}

	return &signingKey{
		id:        newKeyID,
		algorithm: jose.RS256,
		privKey:   key,
	}, nil
}

// ---- Key encoding helpers ----

func encodePrivateKey(key *rsa.PrivateKey) ([]byte, error) {
	privDER := x509.MarshalPKCS1PrivateKey(key)
	block := &pem.Block{Type: "RSA PRIVATE KEY", Bytes: privDER}
	var buf bytes.Buffer
	if err := pem.Encode(&buf, block); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

func encodePublicKey(key *rsa.PrivateKey) (string, error) {
	pubDER, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		return "", err
	}
	block := &pem.Block{Type: "PUBLIC KEY", Bytes: pubDER}
	var buf bytes.Buffer
	if err := pem.Encode(&buf, block); err != nil {
		return "", err
	}
	return buf.String(), nil
}

func parsePrivateKey(pemBytes []byte) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, fmt.Errorf("failed to decode PEM block")
	}
	return x509.ParsePKCS1PrivateKey(block.Bytes)
}

func parseRSAPublicKey(pemBytes []byte) (*rsa.PublicKey, error) {
	block, _ := pem.Decode(pemBytes)
	if block == nil {
		return nil, fmt.Errorf("failed to decode PEM block")
	}
	key, err := x509.ParsePKIXPublicKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse PKIX public key: %w", err)
	}
	pub, ok := key.(*rsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("not an RSA public key")
	}
	return pub, nil
}

// ---- AES-GCM encryption helpers ----

func encryptPEM(plaintext []byte, secretKey string) ([]byte, error) {
	key := []byte(secretKey)
	if len(key) > 32 {
		key = key[:32]
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}
	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}
	nonce := make([]byte, aesGCM.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return nil, fmt.Errorf("generate nonce: %w", err)
	}
	return aesGCM.Seal(nonce, nonce, plaintext, nil), nil
}

func decryptPEM(ciphertext []byte, secretKey string) ([]byte, error) {
	key := []byte(secretKey)
	if len(key) > 32 {
		key = key[:32]
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, fmt.Errorf("create cipher: %w", err)
	}
	aesGCM, err := cipher.NewGCM(block)
	if err != nil {
		return nil, fmt.Errorf("create GCM: %w", err)
	}
	nonceSize := aesGCM.NonceSize()
	if len(ciphertext) < nonceSize {
		return nil, fmt.Errorf("ciphertext too short")
	}
	nonce, ciphertext := ciphertext[:nonceSize], ciphertext[nonceSize:]
	plaintext, err := aesGCM.Open(nil, nonce, ciphertext, nil)
	if err != nil {
		return nil, fmt.Errorf("decrypt: %w", err)
	}
	return plaintext, nil
}
