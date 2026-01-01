package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database/models"
)

var (
	// ErrUserNotFound indicates a user lookup failed.
	ErrUserNotFound = errors.New("user not found")
	// ErrUserExists indicates a user already exists.
	ErrUserExists = errors.New("user already exists")
	// ErrInvalidCredentials indicates a username/password mismatch.
	ErrInvalidCredentials = errors.New("invalid username or password")
)

// Service handles authentication and user management
type Service struct {
	db         *database.DB
	jwtManager *JWTManager
	logger     *slog.Logger

	mu            sync.Mutex
	failed        map[string]*loginAttempts
	lockoutAfter  int
	lockoutWindow time.Duration
	lockoutFor    time.Duration
}

// NewService creates a new auth service
func NewService(db *database.DB, jwtSecret string) *Service {
	return &Service{
		db:            db,
		jwtManager:    NewJWTManager(jwtSecret, 15*time.Minute, 7*24*time.Hour),
		logger:        slog.Default().With("component", "auth"),
		failed:        make(map[string]*loginAttempts),
		lockoutAfter:  5,
		lockoutWindow: 10 * time.Minute,
		lockoutFor:    15 * time.Minute,
	}
}

// LoginRequest represents a login request
type LoginRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
}

// LoginResponse represents a successful login response
type LoginResponse struct {
	User   *models.User `json:"user"`
	Tokens *TokenPair   `json:"tokens"`
}

// RegisterRequest represents a registration request
type RegisterRequest struct {
	Username string `json:"username"`
	Password string `json:"password"`
	Email    string `json:"email"`
}

// Login authenticates a user and returns tokens
func (s *Service) Login(ctx context.Context, req *LoginRequest) (*LoginResponse, error) {
	if s.isLockedOut(req.Username) {
		return nil, fmt.Errorf("account locked, please wait before retrying")
	}
	// Get user by username
	user, err := s.GetUserByUsername(ctx, req.Username)
	if err != nil {
		s.logger.Warn("Login failed: user not found", "username", req.Username)
		s.recordFailure(req.Username)
		return nil, ErrInvalidCredentials
	}

	// Verify password
	if err := VerifyPassword(user.PasswordHash, req.Password); err != nil {
		s.logger.Warn("Login failed: invalid password", "username", req.Username)
		s.recordFailure(req.Username)
		return nil, ErrInvalidCredentials
	}
	s.clearFailures(req.Username)

	// Generate tokens
	tokens, err := s.jwtManager.GenerateTokenPair(user.ID, user.Username, user.Role)
	if err != nil {
		return nil, fmt.Errorf("failed to generate tokens: %w", err)
	}

	s.logger.Info("User logged in", "user_id", user.ID, "username", user.Username)

	return &LoginResponse{
		User:   user,
		Tokens: tokens,
	}, nil
}

// TokenExpiry returns the expiry time from a token's claims.
func (s *Service) TokenExpiry(token string) (time.Time, error) {
	claims, err := s.jwtManager.ValidateToken(token)
	if err != nil {
		return time.Time{}, err
	}
	if claims.ExpiresAt == nil {
		return time.Time{}, ErrInvalidToken
	}
	return claims.ExpiresAt.Time, nil
}

// ValidatePassword enforces password policy.
func (s *Service) ValidatePassword(pw string) error {
	if len(pw) < 12 {
		return errors.New("password must be at least 12 characters")
	}
	var hasLetter, hasDigit bool
	for _, r := range pw {
		switch {
		case 'a' <= r && r <= 'z', 'A' <= r && r <= 'Z':
			hasLetter = true
		case '0' <= r && r <= '9':
			hasDigit = true
		}
	}
	if !hasLetter || !hasDigit {
		return errors.New("password must include letters and numbers")
	}
	return nil
}

type loginAttempts struct {
	count       int
	first       time.Time
	lockedUntil time.Time
}

func (s *Service) recordFailure(username string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	la, ok := s.failed[username]
	now := time.Now()
	if !ok {
		s.failed[username] = &loginAttempts{count: 1, first: now}
		return
	}
	if la.lockedUntil.After(now) {
		return
	}
	if now.Sub(la.first) > s.lockoutWindow {
		la.count = 1
		la.first = now
		return
	}
	la.count++
	if la.count >= s.lockoutAfter {
		la.lockedUntil = now.Add(s.lockoutFor)
	}
}

func (s *Service) clearFailures(username string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.failed, username)
}

func (s *Service) isLockedOut(username string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	la, ok := s.failed[username]
	if !ok {
		return false
	}
	if time.Now().After(la.lockedUntil) {
		return false
	}
	return true
}

// Register creates a new user
func (s *Service) Register(ctx context.Context, req *RegisterRequest) (*models.User, error) {
	// Check if user already exists
	_, err := s.GetUserByUsername(ctx, req.Username)
	if err == nil {
		return nil, ErrUserExists
	}

	// Hash password
	hash, err := HashPassword(req.Password)
	if err != nil {
		return nil, fmt.Errorf("failed to hash password: %w", err)
	}

	// Create user
	user := &models.User{
		ID:           uuid.New().String(),
		Username:     req.Username,
		PasswordHash: hash,
		Email:        req.Email,
		Role:         "user",
		CreatedAt:    time.Now(),
		UpdatedAt:    time.Now(),
	}

	if err := s.CreateUser(ctx, user); err != nil {
		return nil, err
	}

	s.logger.Info("User registered", "user_id", user.ID, "username", user.Username)

	return user, nil
}

// ValidateToken validates a JWT token and returns the claims
func (s *Service) ValidateToken(tokenString string) (*Claims, error) {
	return s.jwtManager.ValidateToken(tokenString)
}

// ValidateAccessToken validates an access token.
func (s *Service) ValidateAccessToken(tokenString string) (*Claims, error) {
	return s.jwtManager.ValidateAccessToken(tokenString)
}

// ValidateRefreshToken validates a refresh token.
func (s *Service) ValidateRefreshToken(tokenString string) (*Claims, error) {
	return s.jwtManager.ValidateRefreshToken(tokenString)
}

// RefreshTokens refreshes tokens using a refresh token
func (s *Service) RefreshTokens(refreshToken string) (*TokenPair, error) {
	return s.jwtManager.RefreshTokens(refreshToken)
}

// DBHealth exposes a simple DB health check for setup/preflight.
func (s *Service) DBHealth() error {
	return s.db.HealthCheck()
}

// CreateUser creates a new user in the database
func (s *Service) CreateUser(ctx context.Context, user *models.User) error {
	query := `
		INSERT INTO users (id, username, password_hash, email, role, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)
	`
	_, err := s.db.Exec(query, user.ID, user.Username, user.PasswordHash, user.Email, user.Role, user.CreatedAt, user.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to create user: %w", err)
	}
	return nil
}

// GetUserByID retrieves a user by ID
func (s *Service) GetUserByID(ctx context.Context, id string) (*models.User, error) {
	query := `SELECT id, username, password_hash, email, role, created_at, updated_at FROM users WHERE id = ?`
	row := s.db.QueryRow(query, id)

	user := &models.User{}
	err := row.Scan(&user.ID, &user.Username, &user.PasswordHash, &user.Email, &user.Role, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return nil, ErrUserNotFound
	}

	return user, nil
}

// GetUserByUsername retrieves a user by username
func (s *Service) GetUserByUsername(ctx context.Context, username string) (*models.User, error) {
	query := `SELECT id, username, password_hash, email, role, created_at, updated_at FROM users WHERE username = ?`
	row := s.db.QueryRow(query, username)

	user := &models.User{}
	err := row.Scan(&user.ID, &user.Username, &user.PasswordHash, &user.Email, &user.Role, &user.CreatedAt, &user.UpdatedAt)
	if err != nil {
		return nil, ErrUserNotFound
	}

	return user, nil
}

// UpdateUser updates a user's information
func (s *Service) UpdateUser(ctx context.Context, user *models.User) error {
	user.UpdatedAt = time.Now()
	query := `
		UPDATE users 
		SET username = ?, email = ?, role = ?, updated_at = ?
		WHERE id = ?
	`
	_, err := s.db.Exec(query, user.Username, user.Email, user.Role, user.UpdatedAt, user.ID)
	if err != nil {
		return fmt.Errorf("failed to update user: %w", err)
	}
	return nil
}

// ChangePassword changes a user's password
func (s *Service) ChangePassword(ctx context.Context, userID, oldPassword, newPassword string) error {
	user, err := s.GetUserByID(ctx, userID)
	if err != nil {
		return err
	}

	// Verify old password
	if err := VerifyPassword(user.PasswordHash, oldPassword); err != nil {
		return ErrInvalidCredentials
	}

	// Hash new password
	hash, err := HashPassword(newPassword)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}

	// Update password
	query := `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`
	_, err = s.db.Exec(query, hash, time.Now(), userID)
	if err != nil {
		return fmt.Errorf("failed to update password: %w", err)
	}

	s.logger.Info("Password changed", "user_id", userID)
	return nil
}

// DeleteUser deletes a user
func (s *Service) DeleteUser(ctx context.Context, id string) error {
	query := `DELETE FROM users WHERE id = ?`
	result, err := s.db.Exec(query, id)
	if err != nil {
		return fmt.Errorf("failed to delete user: %w", err)
	}

	rowsAffected, _ := result.RowsAffected()
	if rowsAffected == 0 {
		return ErrUserNotFound
	}

	s.logger.Info("User deleted", "user_id", id)
	return nil
}

// ListUsers returns all users
func (s *Service) ListUsers(ctx context.Context) ([]*models.User, error) {
	query := `SELECT id, username, password_hash, email, role, created_at, updated_at FROM users ORDER BY created_at DESC`
	rows, err := s.db.Query(query)
	if err != nil {
		return nil, fmt.Errorf("failed to list users: %w", err)
	}
	defer rows.Close()

	var users []*models.User
	for rows.Next() {
		user := &models.User{}
		err := rows.Scan(&user.ID, &user.Username, &user.PasswordHash, &user.Email, &user.Role, &user.CreatedAt, &user.UpdatedAt)
		if err != nil {
			return nil, fmt.Errorf("failed to scan user: %w", err)
		}
		users = append(users, user)
	}

	return users, nil
}

// UserCount returns the number of users
func (s *Service) UserCount(ctx context.Context) (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}
