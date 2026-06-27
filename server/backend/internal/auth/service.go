package auth

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/constants"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database/models"
)

var (
	// ErrUserNotFound indicates a user lookup failed.
	ErrUserNotFound = errors.New("user not found")
	// ErrUserExists indicates the username is already taken.
	ErrUserExists = errors.New("user already exists")
	// ErrEmailExists indicates the email address is already in use.
	ErrEmailExists = errors.New("email already exists")
	// ErrInvalidCredentials indicates a username/password mismatch.
	ErrInvalidCredentials = errors.New("invalid username or password")
	// ErrLastAdmin indicates attempting to delete the last admin user.
	ErrLastAdmin = errors.New("cannot delete the last admin user")
)

// Service handles authentication and user management
type Service struct {
	db         *database.DB
	jwtManager *JWTManager
	tokenStore *TokenStore
	logger     *slog.Logger

	mu            sync.Mutex
	failed        map[string]*loginAttempts
	lockoutAfter  int
	lockoutWindow time.Duration
	lockoutFor    time.Duration

	// MFA: optional WebAuthn verifier (nil = webauthn methods unavailable),
	// TOTP at-rest encryption key, in-flight email OTPs, and pending
	// webauthn registration labels (stashed between begin/finish).
	webauthnVerifier     WebAuthnVerifier
	mfaTOTPEncryptionKey string
	emailOTPMu           sync.Mutex
	emailOTPs            map[string]emailOTPData
	pendingWebAuthnMu    sync.Mutex
	pendingWebAuthnLabel map[string]string
	pendingWebAuthnType  map[string]string
}

// NewService creates a new auth service
func NewService(db *database.DB, jwtSecret string, logger *slog.Logger) *Service {
	svc := &Service{
		db:            db,
		jwtManager:    NewJWTManager(jwtSecret, constants.DefaultJWTAccessTokenExpiry, constants.DefaultJWTRefreshTokenExpiry),
		tokenStore:    NewTokenStore(db, constants.DefaultJWTAccessTokenExpiry, constants.DefaultJWTRefreshTokenExpiry),
		logger:        logger.With("component", "auth"),
		failed:        make(map[string]*loginAttempts),
		lockoutAfter:  constants.DefaultAccountLockoutAfter,
		lockoutWindow: constants.DefaultLockoutWindow,
		lockoutFor:    constants.DefaultLockoutDuration,

		// MFA in-memory stores (must be initialized or the first enrollment / OTP
		// issue panics on nil-map assignment).
		emailOTPs:            make(map[string]emailOTPData),
		pendingWebAuthnLabel: make(map[string]string),
		pendingWebAuthnType:  make(map[string]string),
	}
	svc.loadLockoutsFromDB()
	return svc
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
		// Mitigate timing attacks by performing a dummy hash comparison
		_ = VerifyPassword("$2a$10$dummy.hash.to.mitigate.timing.attacks.12345678901234567890", req.Password)
		return nil, ErrInvalidCredentials
	}

	// Verify password
	if err := VerifyPassword(user.PasswordHash, req.Password); err != nil {
		s.logger.Warn("Login failed: invalid password", "username", req.Username)
		s.recordFailure(req.Username)
		return nil, ErrInvalidCredentials
	}
	s.clearFailures(req.Username)

	// MFA: if the user has ≥1 enabled method, do NOT issue a session — issue a
	// short-lived mfa_token scoped to /auth/mfa/* and require a verify/recover.
	if has, err := s.HasMFA(ctx, user.ID); err != nil {
		return nil, fmt.Errorf("failed to check mfa: %w", err)
	} else if has {
		mfaToken, err := s.issueMFAToken(user.ID, user.Username, user.Role)
		if err != nil {
			return nil, fmt.Errorf("failed to issue mfa token: %w", err)
		}
		methods, err := s.enabledMFAMethodTypes(ctx, user.ID)
		if err != nil {
			return nil, fmt.Errorf("failed to list mfa methods: %w", err)
		}
		return nil, &MFARequiredError{MFAToken: mfaToken, Methods: methods}
	}

	// Generate tokens
	tokens, err := s.jwtManager.GenerateTokenPair(user.ID, user.Username, user.Role)
	if err != nil {
		return nil, fmt.Errorf("failed to generate tokens: %w", err)
	}

	// Update last login time
	now := time.Now()
	if _, err := s.db.Exec(`UPDATE users SET last_login = ? WHERE id = ?`, now, user.ID); err != nil {
		s.logger.Warn("Failed to update last_login", "user_id", user.ID, "error", err)
	}
	user.LastLogin = &now

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
	ctx := context.Background()
	now := time.Now()

	dbOK := true
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO failed_login_attempts (timestamp, username, ip_address, reason) VALUES (?, ?, ?, ?)`,
		now, username, "", "failed_login",
	); err != nil {
		s.logger.Warn("failed to record login failure to DB", "error", err)
		dbOK = false
	}

	var count int
	windowStart := now.Add(-s.lockoutWindow)
	if dbOK {
		if err := s.db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM failed_login_attempts WHERE username = ? AND timestamp > ?`,
			username, windowStart,
		).Scan(&count); err != nil {
			s.logger.Warn("failed to count login failures from DB", "error", err)
			dbOK = false
		}
	}

	lockedUntil := time.Time{}
	if count >= s.lockoutAfter {
		lockedUntil = now.Add(s.lockoutFor)
		if _, err := s.db.ExecContext(ctx,
			`INSERT INTO account_lockouts (username, locked_until) VALUES (?, ?)`,
			username, lockedUntil,
		); err != nil {
			s.logger.Warn("failed to record lockout to DB", "error", err)
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if dbOK {
		s.failed[username] = &loginAttempts{count: count, first: windowStart, lockedUntil: lockedUntil}
	} else {
		la, ok := s.failed[username]
		if !ok {
			s.failed[username] = &loginAttempts{count: 1, first: now}
		} else {
			if la.lockedUntil.After(now) {
				return
			}
			if now.Sub(la.first) > s.lockoutWindow {
				la.count = 1
				la.first = now
			} else {
				la.count++
			}
			if la.count >= s.lockoutAfter {
				la.lockedUntil = now.Add(s.lockoutFor)
			}
		}
	}
}

func (s *Service) clearFailures(username string) {
	ctx := context.Background()
	_, _ = s.db.ExecContext(ctx, `DELETE FROM account_lockouts WHERE username = ?`, username)
	_, _ = s.db.ExecContext(ctx, `DELETE FROM failed_login_attempts WHERE username = ?`, username)

	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.failed, username)
}

func (s *Service) isLockedOut(username string) bool {
	s.mu.Lock()
	la, ok := s.failed[username]
	if ok && la.lockedUntil.After(time.Now()) {
		s.mu.Unlock()
		return true
	}
	s.mu.Unlock()

	ctx := context.Background()
	var lockedUntil time.Time
	err := s.db.QueryRowContext(ctx,
		`SELECT locked_until FROM account_lockouts WHERE username = ? AND locked_until > ? ORDER BY locked_until DESC LIMIT 1`,
		username, time.Now(),
	).Scan(&lockedUntil)
	if err != nil {
		return false
	}

	s.mu.Lock()
	s.failed[username] = &loginAttempts{lockedUntil: lockedUntil}
	s.mu.Unlock()
	return true
}

func (s *Service) loadLockoutsFromDB() {
	ctx := context.Background()
	now := time.Now()
	rows, err := s.db.QueryContext(ctx,
		`SELECT username, locked_until FROM account_lockouts WHERE locked_until > ?`,
		now,
	)
	if err != nil {
		return
	}
	defer rows.Close()

	s.mu.Lock()
	defer s.mu.Unlock()
	for rows.Next() {
		var uname string
		var lockedUntil time.Time
		if err := rows.Scan(&uname, &lockedUntil); err != nil {
			continue
		}
		s.failed[uname] = &loginAttempts{lockedUntil: lockedUntil}
	}
}

// Register creates a new user
func (s *Service) Register(ctx context.Context, req *RegisterRequest) (*models.User, error) {
	// Check if user already exists
	_, err := s.GetUserByUsername(ctx, req.Username)
	if err == nil {
		return nil, ErrUserExists
	}

	// Check if email already exists. Skip this for blank emails: email is
	// optional, and many users may share an empty email, so a blank value must
	// not be treated as a duplicate (otherwise every user created without an
	// email would falsely conflict with the first such user).
	if req.Email != "" {
		_, err = s.GetUserByEmail(ctx, req.Email)
		if err == nil {
			return nil, ErrEmailExists
		}
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
	claims, err := s.jwtManager.ValidateAccessToken(tokenString)
	if err != nil {
		return nil, err
	}

	jti := GetTokenJTI(claims)
	revoked, err := s.tokenStore.IsRevokedOrUserRevokedAll(jti, claims.UserID, "access")
	if err != nil {
		return nil, fmt.Errorf("failed to check token revocation: %w", err)
	}
	if revoked {
		return nil, ErrTokenRevoked
	}

	return claims, nil
}

// ValidateRefreshToken validates a refresh token.
func (s *Service) ValidateRefreshToken(tokenString string) (*Claims, error) {
	return s.jwtManager.ValidateRefreshToken(tokenString)
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
	_, err := s.db.ExecContext(ctx, query, user.ID, user.Username, user.PasswordHash, user.Email, user.Role, user.CreatedAt, user.UpdatedAt)
	if err != nil {
		return fmt.Errorf("failed to create user: %w", err)
	}
	return nil
}

// GetUserByID retrieves a user by ID
func (s *Service) GetUserByID(ctx context.Context, id string) (*models.User, error) {
	query := `SELECT id, username, password_hash, email, role, created_at, updated_at, last_login FROM users WHERE id = ?`
	row := s.db.QueryRowContext(ctx, query, id)

	user := &models.User{}
	err := row.Scan(&user.ID, &user.Username, &user.PasswordHash, &user.Email, &user.Role, &user.CreatedAt, &user.UpdatedAt, &user.LastLogin)
	if err != nil {
		return nil, ErrUserNotFound
	}

	return user, nil
}

// GetUserByUsername retrieves a user by username
func (s *Service) GetUserByUsername(ctx context.Context, username string) (*models.User, error) {
	query := `SELECT id, username, password_hash, email, role, created_at, updated_at, last_login FROM users WHERE username = ?`
	row := s.db.QueryRowContext(ctx, query, username)

	user := &models.User{}
	err := row.Scan(&user.ID, &user.Username, &user.PasswordHash, &user.Email, &user.Role, &user.CreatedAt, &user.UpdatedAt, &user.LastLogin)
	if err != nil {
		return nil, ErrUserNotFound
	}

	return user, nil
}

// GetUserByEmail retrieves a user by email
func (s *Service) GetUserByEmail(ctx context.Context, email string) (*models.User, error) {
	query := `SELECT id, username, password_hash, email, role, created_at, updated_at, last_login FROM users WHERE email = ?`
	row := s.db.QueryRowContext(ctx, query, email)

	user := &models.User{}
	err := row.Scan(&user.ID, &user.Username, &user.PasswordHash, &user.Email, &user.Role, &user.CreatedAt, &user.UpdatedAt, &user.LastLogin)
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
	_, err := s.db.ExecContext(ctx, query, user.Username, user.Email, user.Role, user.UpdatedAt, user.ID)
	if err != nil {
		return fmt.Errorf("failed to update user: %w", err)
	}
	return nil
}

// ChangePassword changes a user's password and revokes all existing tokens.
func (s *Service) ChangePassword(ctx context.Context, userID, oldPassword, newPassword string) error {
	user, err := s.GetUserByID(ctx, userID)
	if err != nil {
		return err
	}

	// Verify old password
	if err := VerifyPassword(user.PasswordHash, oldPassword); err != nil {
		return ErrInvalidCredentials
	}

	return s.setPasswordInternal(ctx, user, newPassword, "Password changed")
}

// ResetPasswordWithToken resets a user's password using a valid reset token (bypasses old password check).
func (s *Service) ResetPasswordWithToken(ctx context.Context, userID, newPassword string) error {
	user, err := s.GetUserByID(ctx, userID)
	if err != nil {
		return err
	}

	return s.setPasswordInternal(ctx, user, newPassword, "Password reset via token")
}

// setPasswordInternal is a helper that sets a new password and revokes tokens.
func (s *Service) setPasswordInternal(ctx context.Context, user *models.User, newPassword, reason string) error {
	// Prevent reusing the current password
	if err := VerifyPassword(user.PasswordHash, newPassword); err == nil {
		return fmt.Errorf("new password must be different from current password")
	}

	// Hash new password
	hash, err := HashPassword(newPassword)
	if err != nil {
		return fmt.Errorf("failed to hash password: %w", err)
	}

	// Update password
	query := `UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?`
	_, err = s.db.ExecContext(ctx, query, hash, time.Now(), user.ID)
	if err != nil {
		return fmt.Errorf("failed to update password: %w", err)
	}

	// Invalidate all password reset tokens for this user
	_, err = s.db.ExecContext(ctx, `
		UPDATE password_reset_tokens SET used = TRUE WHERE user_id = ?
	`, user.ID)
	if err != nil {
		s.logger.Warn("Failed to invalidate password reset tokens", "user_id", user.ID, "error", err)
	}

	// Revoke all tokens for this user (force re-login)
	if err := s.RevokeAllTokens(user.ID, user.ID, reason); err != nil {
		s.logger.Error("Failed to revoke tokens after password change", "user_id", user.ID, "error", err)
	}

	s.logger.Info("Password changed", "user_id", user.ID, "reason", reason)
	return nil
}

// DeleteUser deletes a user
func (s *Service) DeleteUser(ctx context.Context, id string) error {
	// Check if this is the last admin
	user, err := s.GetUserByID(ctx, id)
	if err != nil {
		return ErrUserNotFound
	}

	if user.Role == "admin" {
		var adminCount int
		if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE role = 'admin'`).Scan(&adminCount); err != nil {
			return fmt.Errorf("failed to count admins: %w", err)
		}
		if adminCount <= 1 {
			return ErrLastAdmin
		}
	}

	query := `DELETE FROM users WHERE id = ?`
	result, err := s.db.ExecContext(ctx, query, id)
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
	query := `SELECT id, username, email, role, created_at, updated_at, last_login FROM users ORDER BY created_at DESC`
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, fmt.Errorf("failed to list users: %w", err)
	}
	defer func() {
		if cerr := rows.Close(); cerr != nil {
			s.logger.Warn("failed to close rows", "error", cerr)
		}
	}()

	var users []*models.User
	for rows.Next() {
		user := &models.User{}
		err := rows.Scan(&user.ID, &user.Username, &user.Email, &user.Role, &user.CreatedAt, &user.UpdatedAt, &user.LastLogin)
		if err != nil {
			return nil, fmt.Errorf("failed to scan user: %w", err)
		}
		users = append(users, user)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("failed to iterate users: %w", err)
	}

	return users, nil
}

// ListUsersPaginated returns users with pagination support
func (s *Service) ListUsersPaginated(ctx context.Context, offset, limit int) ([]*models.User, int64, error) {
	// Get total count
	var total int64
	if err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("failed to count users: %w", err)
	}

	// Get paginated users
	query := `SELECT id, username, email, role, created_at, updated_at, last_login 
		FROM users 
		ORDER BY created_at DESC 
		LIMIT ? OFFSET ?`
	rows, err := s.db.QueryContext(ctx, query, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("failed to list users: %w", err)
	}
	defer func() {
		if cerr := rows.Close(); cerr != nil {
			s.logger.Warn("failed to close rows", "error", cerr)
		}
	}()

	var users []*models.User
	for rows.Next() {
		user := &models.User{}
		err := rows.Scan(&user.ID, &user.Username, &user.Email, &user.Role, &user.CreatedAt, &user.UpdatedAt, &user.LastLogin)
		if err != nil {
			return nil, 0, fmt.Errorf("failed to scan user: %w", err)
		}
		users = append(users, user)
	}

	if err := rows.Err(); err != nil {
		return nil, 0, fmt.Errorf("failed to iterate users: %w", err)
	}

	return users, total, nil
}

// UserCount returns the number of users
func (s *Service) UserCount(ctx context.Context) (int, error) {
	var count int
	err := s.db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&count)
	if err != nil {
		return 0, err
	}
	return count, nil
}

// RevokeToken revokes a specific token by its JTI.
func (s *Service) RevokeToken(jti, userID, tokenType, revokedBy, reason string) error {
	return s.tokenStore.RevokeToken(jti, userID, tokenType, revokedBy, reason)
}

// IsTokenRevoked checks if a token has been revoked.
func (s *Service) IsTokenRevoked(jti, tokenType string) (bool, error) {
	return s.tokenStore.IsRevoked(jti, tokenType)
}

// RevokeAllTokens revokes all tokens for a user (used on logout or password change).
func (s *Service) RevokeAllTokens(userID, revokedBy, reason string) error {
	s.logger.Info("Revoking all tokens for user", "user_id", userID, "revoked_by", revokedBy)
	return s.tokenStore.RevokeAllTokens(userID, revokedBy, reason)
}

// RevokeRefreshToken revokes a specific refresh token (part of rotation).
func (s *Service) RevokeRefreshToken(jti, userID, revokedBy, reason string) error {
	return s.tokenStore.RevokeToken(jti, userID, "refresh", revokedBy, reason)
}

// RefreshTokensWithRotation validates a refresh token, revokes it, and returns new tokens.
// This implements proper JWT token rotation (#19) - each refresh token can only be used once.
func (s *Service) RefreshTokensWithRotation(refreshToken, revokedBy string) (*TokenPair, error) {
	claims, err := s.jwtManager.ValidateRefreshToken(refreshToken)
	if err != nil {
		return nil, err
	}

	jti := GetTokenJTI(claims)

	// Atomically check if revoked and revoke in one operation to prevent race conditions.
	// Also handles user-wide revocation (revoke-all) by checking sentinel rows.
	revoked, err := s.tokenStore.RevokeTokenIfNotRevoked(
		jti, claims.UserID, "refresh", revokedBy, "Token rotation - consumed",
	)
	if err != nil {
		return nil, fmt.Errorf("failed to check token revocation: %w", err)
	}
	if !revoked {
		// Token was already revoked — possible token reuse attack.
		// Also check if user-wide revocation was the cause.
		userRevoked, checkErr := s.tokenStore.IsRevokedOrUserRevokedAll(jti, claims.UserID, "refresh")
		if checkErr == nil && !userRevoked {
			// Specific token reuse detected (not from revoke-all), revoke all tokens.
			s.logger.Warn("Refresh token reuse detected - possible token theft", "user_id", claims.UserID, "jti", jti)
			_ = s.tokenStore.RevokeAllTokens(claims.UserID, "system", "Suspicious refresh token reuse detected")
		}
		return nil, ErrTokenRevoked
	}

	newTokens, err := s.jwtManager.GenerateTokenPair(claims.UserID, claims.Username, claims.Role)
	if err != nil {
		return nil, fmt.Errorf("failed to generate new tokens: %w", err)
	}

	s.logger.Info("Tokens rotated", "user_id", claims.UserID)

	return newTokens, nil
}

// CleanupExpiredRevocations removes expired revocation records.
func (s *Service) CleanupExpiredRevocations() (int64, error) {
	return s.tokenStore.CleanupExpired()
}

func (s *Service) CleanupExpiredLockouts() (int64, error) {
	result, err := s.db.Exec(`DELETE FROM account_lockouts WHERE locked_until < ?`, time.Now())
	if err != nil {
		return 0, err
	}
	n, _ := result.RowsAffected()
	return n, nil
}
