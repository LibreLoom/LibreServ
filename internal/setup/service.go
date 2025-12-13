package setup

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

const (
	StatusPending    = "pending"
	StatusInProgress = "in_progress"
	StatusComplete   = "complete"
)

// State tracks first-boot setup status.
type State struct {
	Status      string     `json:"status"`
	Nonce       string     `json:"nonce"`
	StartedAt   *time.Time `json:"started_at,omitempty"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
}

// Service manages setup state in the database.
type Service struct {
	db *database.DB
	mu sync.Mutex
}

func NewService(db *database.DB) *Service {
	return &Service{db: db}
}

// Ensure initializes setup_state row if missing and returns current state.
func (s *Service) Ensure(ctx context.Context) (*State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	state, err := s.get(ctx)
	if err == nil {
		return state, nil
	}

	nonce := generateNonce()
	now := time.Now()
	_, err = s.db.Exec(`
		INSERT INTO setup_state (id, status, nonce, started_at) VALUES (1, ?, ?, ?)
	`, StatusPending, nonce, now)
	if err != nil {
		return nil, fmt.Errorf("init setup state: %w", err)
	}

	return &State{
		Status:    StatusPending,
		Nonce:     nonce,
		StartedAt: &now,
	}, nil
}

// Get returns current state.
func (s *Service) Get(ctx context.Context) (*State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.get(ctx)
}

// MarkInProgress marks setup as in progress, regenerating nonce.
func (s *Service) MarkInProgress(ctx context.Context) (*State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	nonce := generateNonce()
	now := time.Now()
	_, err := s.db.Exec(`
		UPDATE setup_state SET status = ?, nonce = ?, started_at = ? WHERE id = 1
	`, StatusInProgress, nonce, now)
	if err != nil {
		return nil, fmt.Errorf("mark in progress: %w", err)
	}
	return &State{Status: StatusInProgress, Nonce: nonce, StartedAt: &now}, nil
}

// MarkComplete marks setup as complete.
func (s *Service) MarkComplete(ctx context.Context) (*State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	_, err := s.db.Exec(`
		UPDATE setup_state SET status = ?, completed_at = ? WHERE id = 1
	`, StatusComplete, now)
	if err != nil {
		return nil, fmt.Errorf("mark complete: %w", err)
	}
	return &State{Status: StatusComplete, CompletedAt: &now}, nil
}

// IsComplete returns true if setup finished.
func (s *Service) IsComplete(ctx context.Context) bool {
	state, err := s.Get(ctx)
	if err != nil {
		return false
	}
	return state.Status == StatusComplete
}

func (s *Service) get(ctx context.Context) (*State, error) {
	row := s.db.QueryRow(`
		SELECT status, nonce, started_at, completed_at FROM setup_state WHERE id = 1
	`)
	st := &State{}
	var started, completed sqlNullTime
	if err := row.Scan(&st.Status, &st.Nonce, &started, &completed); err != nil {
		return nil, err
	}
	if started.Valid {
		st.StartedAt = &started.Time
	}
	if completed.Valid {
		st.CompletedAt = &completed.Time
	}
	return st, nil
}

type sqlNullTime struct {
	Time  time.Time
	Valid bool
}

func (n *sqlNullTime) Scan(value interface{}) error {
	if value == nil {
		n.Valid = false
		return nil
	}
	switch v := value.(type) {
	case time.Time:
		n.Time = v
		n.Valid = true
		return nil
	case sql.NullTime:
		if v.Valid {
			n.Time = v.Time
			n.Valid = true
		}
		return nil
	default:
		return errors.New("invalid time type")
	}
}

func generateNonce() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}
