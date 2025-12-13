package support

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"fmt"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

type Status string

const (
	StatusActive  Status = "active"
	StatusRevoked Status = "revoked"
	StatusExpired Status = "expired"
)

type Session struct {
	ID           string     `json:"id"`
	Code         string     `json:"code"`
	Token        string     `json:"token"`
	Scopes       []string   `json:"scopes"`
	Status       Status     `json:"status"`
	ExpiresAt    time.Time  `json:"expires_at"`
	CreatedAt    time.Time  `json:"created_at"`
	CreatedBy    string     `json:"created_by"`
	RevokedAt    *time.Time `json:"revoked_at,omitempty"`
	RevokedBy    string     `json:"revoked_by,omitempty"`
	SupportLevel string     `json:"support_level,omitempty"`
	LicenseID    string     `json:"license_id,omitempty"`
}

type Service struct {
	db      *database.DB
	license LicenseChecker
	audit   *AuditLogger
}

type LicenseChecker interface {
	Valid() bool
	SupportLevel() string
	LicenseID() string
	Reason() string
}

func NewService(db *database.DB, lic LicenseChecker) *Service {
	return &Service{db: db, license: lic, audit: NewAuditLogger(db)}
}

type CreateRequest struct {
	Scopes    []string
	TTL       time.Duration
	CreatedBy string
}

func (s *Service) CreateSession(ctx context.Context, req CreateRequest) (*Session, error) {
	if s.license != nil && !s.license.Valid() {
		return nil, fmt.Errorf("support license invalid: %s", s.license.Reason())
	}
	if req.TTL == 0 {
		req.TTL = time.Hour
	}
	if len(req.Scopes) == 0 {
		req.Scopes = []string{"diagnostics"}
	}
	id := generateID()
	code := generateCode()
	token := generateToken()
	now := time.Now()
	expires := now.Add(req.TTL)

	if _, err := s.db.Exec(`
		INSERT INTO support_sessions (id, code, token, scopes, status, expires_at, created_at, created_by, support_level, license_id)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`, id, code, token, strings.Join(req.Scopes, ","), string(StatusActive), expires, now, req.CreatedBy, s.supportLevel(), s.licenseID()); err != nil {
		return nil, fmt.Errorf("create support session: %w", err)
	}

	return &Session{
		ID:           id,
		Code:         code,
		Token:        token,
		Scopes:       req.Scopes,
		Status:       StatusActive,
		ExpiresAt:    expires,
		CreatedAt:    now,
		CreatedBy:    req.CreatedBy,
		SupportLevel: s.supportLevel(),
		LicenseID:    s.licenseID(),
	}, nil
}

func (s *Service) ListSessions(ctx context.Context, limit int) ([]*Session, error) {
	if limit <= 0 || limit > 100 {
		limit = 50
	}
	rows, err := s.db.Query(`
		SELECT id, code, token, scopes, status, expires_at, created_at, created_by, revoked_at, revoked_by, support_level, license_id
		FROM support_sessions
		ORDER BY created_at DESC
		LIMIT ?
	`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var sessions []*Session
	for rows.Next() {
		var sess Session
		var scopes string
		var revokedAt sql.NullTime
		var revokedBy sql.NullString
		if err := rows.Scan(&sess.ID, &sess.Code, &sess.Token, &scopes, &sess.Status, &sess.ExpiresAt, &sess.CreatedAt, &sess.CreatedBy, &revokedAt, &revokedBy, &sess.SupportLevel, &sess.LicenseID); err != nil {
			continue
		}
		sess.Scopes = splitScopes(scopes)
		if sess.Status == StatusActive && time.Now().After(sess.ExpiresAt) {
			sess.Status = StatusExpired
			_ = s.markExpired(ctx, sess.ID)
		}
		if revokedAt.Valid {
			sess.RevokedAt = &revokedAt.Time
		}
		if revokedBy.Valid {
			sess.RevokedBy = revokedBy.String
		}
		sessions = append(sessions, &sess)
	}
	return sessions, nil
}

// GetSession fetches a session by ID.
func (s *Service) GetSession(ctx context.Context, id string) (*Session, error) {
	row := s.db.QueryRow(`
		SELECT id, code, token, scopes, status, expires_at, created_at, created_by, revoked_at, revoked_by, support_level, license_id
		FROM support_sessions
		WHERE id = ?
	`, id)

	var sess Session
	var scopes string
	var revokedAt sql.NullTime
	var revokedBy sql.NullString
	if err := row.Scan(&sess.ID, &sess.Code, &sess.Token, &scopes, &sess.Status, &sess.ExpiresAt, &sess.CreatedAt, &sess.CreatedBy, &revokedAt, &revokedBy, &sess.SupportLevel, &sess.LicenseID); err != nil {
		return nil, err
	}
	sess.Scopes = splitScopes(scopes)
	if sess.Status == StatusActive && time.Now().After(sess.ExpiresAt) {
		sess.Status = StatusExpired
	}
	if revokedAt.Valid {
		sess.RevokedAt = &revokedAt.Time
	}
	if revokedBy.Valid {
		sess.RevokedBy = revokedBy.String
	}
	return &sess, nil
}

// ValidateCode returns an active session matching code/token.
func (s *Service) ValidateCode(ctx context.Context, code, token string) (*Session, error) {
	row := s.db.QueryRow(`
		SELECT id, code, token, scopes, status, expires_at, created_at, created_by, revoked_at, revoked_by, support_level, license_id
		FROM support_sessions
		WHERE code = ? AND token = ?
	`, code, token)
	var sess Session
	var scopes string
	var revokedAt sql.NullTime
	var revokedBy sql.NullString
	if err := row.Scan(&sess.ID, &sess.Code, &sess.Token, &scopes, &sess.Status, &sess.ExpiresAt, &sess.CreatedAt, &sess.CreatedBy, &revokedAt, &revokedBy, &sess.SupportLevel, &sess.LicenseID); err != nil {
		return nil, err
	}
	now := time.Now()
	if sess.Status != StatusActive {
		return nil, fmt.Errorf("session not active")
	}
	if now.After(sess.ExpiresAt) {
		// Mark expired for future queries
		_ = s.markExpired(ctx, sess.ID)
		return nil, fmt.Errorf("session expired")
	}
	sess.Scopes = splitScopes(scopes)
	if revokedAt.Valid {
		sess.RevokedAt = &revokedAt.Time
	}
	if revokedBy.Valid {
		sess.RevokedBy = revokedBy.String
	}
	return &sess, nil
}

// LogAudit records an audit entry.
func (s *Service) LogAudit(ctx context.Context, entry *AuditEntry) {
	if s.audit == nil {
		return
	}
	_ = s.audit.Log(ctx, entry)
}

func (s *Service) RevokeSession(ctx context.Context, id, by string) error {
	now := time.Now()
	_, err := s.db.Exec(`
		UPDATE support_sessions
		SET status = ?, revoked_at = ?, revoked_by = ?
		WHERE id = ?
	`, string(StatusRevoked), now, by, id)
	return err
}

func splitScopes(s string) []string {
	var scopes []string
	for _, part := range strings.Split(s, ",") {
		if p := strings.TrimSpace(part); p != "" {
			scopes = append(scopes, p)
		}
	}
	return scopes
}

func generateCode() string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return strings.ToUpper(hex.EncodeToString(b))
}

func generateID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func generateToken() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func (s *Service) supportLevel() string {
	if s.license != nil && s.license.Valid() {
		return s.license.SupportLevel()
	}
	return ""
}

func (s *Service) licenseID() string {
	if s.license != nil && s.license.Valid() {
		return s.license.LicenseID()
	}
	return ""
}

func (s *Service) markExpired(ctx context.Context, id string) error {
	_, err := s.db.Exec(`UPDATE support_sessions SET status = ? WHERE id = ?`, string(StatusExpired), id)
	return err
}
