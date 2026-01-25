package models

import "time"

// RevokedToken represents a revoked JWT token record.
type RevokedToken struct {
	ID        int64     `json:"id"`
	TokenJTI  string    `json:"token_jti"`
	UserID    string    `json:"user_id"`
	TokenType string    `json:"token_type"`
	RevokedAt time.Time `json:"revoked_at"`
	RevokedBy string    `json:"revoked_by"`
	Reason    string    `json:"reason"`
	ExpiresAt time.Time `json:"expires_at"`
}

// RevokedTokenRepository defines database operations for revoked tokens.
type RevokedTokenRepository interface {
	Revoke(tokenJTI, userID, tokenType, revokedBy, reason string, expiresAt time.Time) error
	IsRevoked(tokenJTI, tokenType string) (bool, error)
	RevokeByUser(userID, tokenType, revokedBy, reason string) error
	RevokeAll(userID, revokedBy, reason string) error
	RevokeAccessTokens(userID, revokedBy, reason string) error
	RevokeRefreshTokens(userID, revokedBy, reason string) error
	CleanupExpired() (int64, error)
}
