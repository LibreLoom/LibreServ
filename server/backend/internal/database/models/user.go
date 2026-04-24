package models

import "time"

// User represents an application user record.
type User struct {
	ID           string     `json:"id"`
	Username     string     `json:"username"`
	PasswordHash string     `json:"-"` // Never return password hash in JSON
	Email        string     `json:"email"`
	Role         string     `json:"role"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	LastLogin    *time.Time `json:"last_login,omitempty"`
}

// Sanitize returns a copy with sensitive fields cleared for API responses.
func (u *User) Sanitize() *User {
	if u == nil {
		return nil
	}
	return &User{
		ID:        u.ID,
		Username:  u.Username,
		Email:     u.Email,
		Role:      u.Role,
		CreatedAt: u.CreatedAt,
		UpdatedAt: u.UpdatedAt,
		LastLogin: u.LastLogin,
	}
}

// UserRepository defines database operations for users.
type UserRepository interface {
	Create(user *User) error
	GetByID(id string) (*User, error)
	GetByUsername(username string) (*User, error)
	Update(user *User) error
	Delete(id string) error
}
