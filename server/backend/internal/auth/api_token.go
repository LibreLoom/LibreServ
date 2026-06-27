package auth

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database/models"
)

var (
	// ErrAPITokenNotFound indicates an API token lookup failed or the caller
	// does not own it.
	ErrAPITokenNotFound = errors.New("api token not found")
	// ErrAPITokenRevoked indicates the presented API token has been revoked.
	ErrAPITokenRevoked = errors.New("api token has been revoked")
	// ErrAPITokenLimitReached indicates the user already holds the maximum
	// number of active API tokens.
	ErrAPITokenLimitReached = errors.New("api token limit reached")
)

// MaxAPITokensPerUser caps the number of active (non-revoked) API tokens a
// user may hold, to prevent unbounded growth (e.g. a compromised session
// scripting token creation). It is a package var so tests can lower it.
var MaxAPITokensPerUser = 50

// apiTokenPrefix tags LibreServ API tokens so they are visually distinct from
// JWTs and easy to grep for in logs. JWTs contain '.'; API tokens do not.
const apiTokenPrefix = "lsat_"

// generateAPIToken returns a new random API token: "lsat_" + 32 random bytes
// encoded as unpadded base64url (~43 chars total).
func generateAPIToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("failed to generate api token: %w", err)
	}
	return apiTokenPrefix + base64.RawURLEncoding.EncodeToString(b), nil
}

// hashAPIToken returns the SHA-256 hex digest of an API token — the value stored.
func hashAPIToken(token string) string {
	h := sha256.Sum256([]byte(token))
	return hex.EncodeToString(h[:])
}

// IsAPIToken reports whether a presented bearer token looks like an API token
// (has the lsat_ prefix). Used by the auth middleware to decide whether to try
// API-token validation after JWT validation fails.
func IsAPIToken(token string) bool {
	return len(token) > len(apiTokenPrefix) && token[:len(apiTokenPrefix)] == apiTokenPrefix
}

// CreateAPIToken creates a new API token for a user and returns the plaintext
// token (shown once — the caller must convey it to the user) plus the stored
// record with the hash cleared.
func (s *Service) CreateAPIToken(ctx context.Context, userID, name string) (string, *models.APIToken, error) {
	// Enforce a per-user cap on active tokens to prevent unbounded growth.
	var count int
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM api_tokens WHERE user_id = ? AND revoked_at IS NULL`, userID).Scan(&count); err != nil {
		return "", nil, fmt.Errorf("failed to count api tokens: %w", err)
	}
	if count >= MaxAPITokensPerUser {
		return "", nil, ErrAPITokenLimitReached
	}
	plaintext, err := generateAPIToken()
	if err != nil {
		return "", nil, err
	}
	now := time.Now()
	t := &models.APIToken{
		ID:          uuid.NewString(),
		UserID:      userID,
		Name:        name,
		TokenHash:   hashAPIToken(plaintext),
		TokenPrefix: plaintext[:len(apiTokenPrefix)+8], // lsat_ + 8 chars for display
		CreatedAt:   now,
	}
	query := `INSERT INTO api_tokens (id, user_id, name, token_hash, token_prefix, created_at) VALUES (?, ?, ?, ?, ?, ?)`
	if _, err := s.db.ExecContext(ctx, query, t.ID, t.UserID, t.Name, t.TokenHash, t.TokenPrefix, t.CreatedAt); err != nil {
		return "", nil, fmt.Errorf("failed to create api token: %w", err)
	}
	t.TokenHash = "" // never expose the hash in responses
	return plaintext, t, nil
}

// ValidateAPIToken looks up an API token by its hash, rejects revoked tokens,
// touches last_used_at (best-effort), and returns the owning user. Used by the
// auth middleware as a fallback when the bearer token is not a valid JWT.
func (s *Service) ValidateAPIToken(ctx context.Context, token string) (*models.User, error) {
	hash := hashAPIToken(token)
	var (
		userID    string
		revokedAt *time.Time
	)
	query := `SELECT user_id, revoked_at FROM api_tokens WHERE token_hash = ?`
	if err := s.db.QueryRowContext(ctx, query, hash).Scan(&userID, &revokedAt); err != nil {
		return nil, ErrAPITokenNotFound
	}
	if revokedAt != nil {
		return nil, ErrAPITokenRevoked
	}
	// Best-effort: update last_used_at without failing the request on error.
	_, _ = s.db.ExecContext(ctx, `UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?`, time.Now(), hash)
	return s.GetUserByID(ctx, userID)
}

// ListAPITokens returns a user's API tokens (hashes excluded), newest first,
// including revoked ones so the user can see history.
func (s *Service) ListAPITokens(ctx context.Context, userID string) ([]*models.APIToken, error) {
	query := `SELECT id, user_id, name, token_prefix, created_at, last_used_at, revoked_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`
	rows, err := s.db.QueryContext(ctx, query, userID)
	if err != nil {
		return nil, fmt.Errorf("failed to list api tokens: %w", err)
	}
	defer rows.Close()

	var out []*models.APIToken
	for rows.Next() {
		t := &models.APIToken{}
		if err := rows.Scan(&t.ID, &t.UserID, &t.Name, &t.TokenPrefix, &t.CreatedAt, &t.LastUsedAt, &t.RevokedAt); err != nil {
			return nil, fmt.Errorf("failed to scan api token: %w", err)
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

// RevokeAPIToken revokes an API token. Only the owning user may revoke it
// (the WHERE user_id = ? check prevents cross-user revocation).
func (s *Service) RevokeAPIToken(ctx context.Context, userID, tokenID string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE api_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL`, time.Now(), tokenID, userID)
	if err != nil {
		return fmt.Errorf("failed to revoke api token: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrAPITokenNotFound
	}
	return nil
}
