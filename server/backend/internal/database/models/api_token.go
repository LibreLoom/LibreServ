package models

import "time"

// APIToken represents a long-lived token for programmatic API access.
// The plaintext token is returned exactly once at creation (CreateAPIToken);
// only the SHA-256 hash is persisted. Responses never include the hash.
type APIToken struct {
	ID          string     `json:"id"`
	UserID      string     `json:"-"`
	Name        string     `json:"name"`
	TokenHash   string     `json:"-"`
	TokenPrefix string     `json:"token_prefix"` // lsat_ + first 8 chars, for display
	CreatedAt   time.Time  `json:"created_at"`
	LastUsedAt  *time.Time `json:"last_used_at,omitempty"`
	RevokedAt   *time.Time `json:"revoked_at,omitempty"`
}
