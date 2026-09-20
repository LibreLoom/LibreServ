package models

import "time"

// InviteToken represents an admin-initiated account-creation invite. Only the
// token hash is persisted; the plaintext bearer token is returned once at
// creation (emailed to the invitee). Single-use, expiring.
type InviteToken struct {
	ID         string     `json:"id"`
	Email      string     `json:"email"`
	Role       string     `json:"role"`
	InviterID  string     `json:"-"`
	TokenHash  string     `json:"-"`
	ExpiresAt  time.Time  `json:"expires_at"`
	RedeemedAt *time.Time `json:"redeemed_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
}
