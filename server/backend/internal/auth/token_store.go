package auth

import (
	"fmt"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

// TokenStore handles JWT token revocation and persistence.
type TokenStore struct {
	db            *database.DB
	accessExpiry  time.Duration
	refreshExpiry time.Duration
}

// NewTokenStore creates a new TokenStore.
func NewTokenStore(db *database.DB, accessExpiry, refreshExpiry time.Duration) *TokenStore {
	return &TokenStore{
		db:            db,
		accessExpiry:  accessExpiry,
		refreshExpiry: refreshExpiry,
	}
}

// RevokeToken marks a token as revoked by its JTI.
func (s *TokenStore) RevokeToken(jti, userID, tokenType, revokedBy, reason string) error {
	var expiresAt time.Time
	if tokenType == "access" {
		expiresAt = time.Now().Add(s.accessExpiry)
	} else {
		expiresAt = time.Now().Add(s.refreshExpiry)
	}

	query := `
		INSERT INTO revoked_tokens (token_jti, user_id, token_type, revoked_by, reason, expires_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`
	_, err := s.db.Exec(query, jti, userID, tokenType, revokedBy, reason, expiresAt)
	if err != nil {
		return fmt.Errorf("failed to revoke token: %w", err)
	}
	return nil
}

// IsRevoked checks if a token has been revoked by its JTI.
func (s *TokenStore) IsRevoked(jti, tokenType string) (bool, error) {
	query := `
		SELECT EXISTS(SELECT 1 FROM revoked_tokens WHERE token_jti = ? AND token_type = ?)
	`
	var exists bool
	err := s.db.QueryRow(query, jti, tokenType).Scan(&exists)
	if err != nil {
		return false, fmt.Errorf("failed to check token revocation: %w", err)
	}
	return exists, nil
}

// RevokeByUser revokes all tokens of a specific type for a user.
func (s *TokenStore) RevokeByUser(userID, tokenType, revokedBy, reason string) error {
	expiresAt := s.refreshExpiry
	if tokenType == "access" {
		expiresAt = s.accessExpiry
	}

	query := `
		INSERT INTO revoked_tokens (token_jti, user_id, token_type, revoked_by, reason, expires_at)
		VALUES (?, ?, ?, ?, ?, ?)
	`
	_, err := s.db.Exec(query, "revoke-all-"+tokenType+"-"+userID, userID, tokenType, revokedBy, reason, time.Now().Add(expiresAt))
	if err != nil {
		return fmt.Errorf("failed to revoke tokens by user: %w", err)
	}
	return nil
}

// RevokeAllTokens revokes all tokens (access and refresh) for a user.
func (s *TokenStore) RevokeAllTokens(userID, revokedBy, reason string) error {
	query := `
		INSERT INTO revoked_tokens (token_jti, user_id, token_type, revoked_by, reason, expires_at)
		VALUES (?, ?, 'access', ?, ?, ?)
	`
	_, err := s.db.Exec(query, "revoke-all-access-"+userID, userID, revokedBy, reason, time.Now().Add(s.accessExpiry))
	if err != nil {
		return fmt.Errorf("failed to revoke access tokens: %w", err)
	}

	query = `
		INSERT INTO revoked_tokens (token_jti, user_id, token_type, revoked_by, reason, expires_at)
		VALUES (?, ?, 'refresh', ?, ?, ?)
	`
	_, err = s.db.Exec(query, "revoke-all-refresh-"+userID, userID, revokedBy, reason, time.Now().Add(s.refreshExpiry))
	if err != nil {
		return fmt.Errorf("failed to revoke refresh tokens: %w", err)
	}

	return nil
}

// CleanupExpired removes expired revoked token records.
func (s *TokenStore) CleanupExpired() (int64, error) {
	result, err := s.db.Exec(`DELETE FROM revoked_tokens WHERE expires_at < ?`, time.Now())
	if err != nil {
		return 0, fmt.Errorf("failed to cleanup expired tokens: %w", err)
	}
	count, _ := result.RowsAffected()
	return count, nil
}

// GetTokenJTI extracts the JTI from a parsed token's claims.
func GetTokenJTI(claims *Claims) string {
	if claims.JTI != "" {
		return claims.JTI
	}
	return claims.ID
}
