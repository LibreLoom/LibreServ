package setup

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
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

type State struct {
	Status            string                 `json:"status"`
	Nonce             string                 `json:"nonce"`
	StartedAt         *time.Time             `json:"started_at,omitempty"`
	CompletedAt       *time.Time             `json:"completed_at,omitempty"`
	CurrentStep       string                 `json:"current_step"`
	CurrentSubStep    string                 `json:"current_sub_step,omitempty"`
	StepData          map[string]interface{} `json:"step_data"`
	ProgressUpdatedAt *time.Time             `json:"progress_updated_at,omitempty"`
}

type Service struct {
	db *database.DB
	mu sync.Mutex
}

func NewService(db *database.DB) *Service {
	return &Service{db: db}
}

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
		INSERT INTO setup_state (id, status, nonce, started_at, current_step, step_data)
		VALUES (1, ?, ?, ?, ?, '{}')
	`, StatusPending, nonce, now, StepChecking)
	if err != nil {
		return nil, fmt.Errorf("init setup state: %w", err)
	}

	return &State{
		Status:      StatusPending,
		Nonce:       nonce,
		StartedAt:   &now,
		CurrentStep: StepChecking,
		StepData:    map[string]interface{}{},
	}, nil
}

func (s *Service) Get(ctx context.Context) (*State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.get(ctx)
}

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

func (s *Service) MarkComplete(ctx context.Context) (*State, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	_, err := s.db.Exec(`
		UPDATE setup_state SET status = ?, completed_at = ?, current_step = ?, current_sub_step = NULL, step_data = '{}', progress_updated_at = ?
		WHERE id = 1
	`, StatusComplete, now, StepComplete, now)
	if err != nil {
		return nil, fmt.Errorf("mark complete: %w", err)
	}
	return &State{Status: StatusComplete, CompletedAt: &now, CurrentStep: StepComplete}, nil
}

func (s *Service) IsComplete(ctx context.Context) bool {
	state, err := s.Get(ctx)
	if err != nil {
		return false
	}
	return state.Status == StatusComplete
}

func (s *Service) SaveProgress(ctx context.Context, currentStep, currentSubStep string, stepData map[string]interface{}) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	var dataJSON []byte
	if stepData == nil {
		dataJSON = []byte("{}")
	} else {
		var err error
		dataJSON, err = json.Marshal(stepData)
		if err != nil {
			return fmt.Errorf("marshal step_data: %w", err)
		}
	}

	now := time.Now()
	result, err := s.db.Exec(`
		UPDATE setup_state
		SET current_step = ?, current_sub_step = ?, step_data = ?, progress_updated_at = ?
		WHERE id = 1 AND (progress_updated_at IS NULL OR progress_updated_at < ?)
	`, currentStep, nullIfEmpty(currentSubStep), string(dataJSON), now, now)
	if err != nil {
		return fmt.Errorf("save progress: %w", err)
	}

	rows, _ := result.RowsAffected()
	if rows == 0 {
		return fmt.Errorf("progress save rejected: stale timestamp")
	}
	return nil
}

func (s *Service) get(ctx context.Context) (*State, error) {
	row := s.db.QueryRow(`
		SELECT status, nonce, started_at, completed_at, current_step, current_sub_step, step_data, progress_updated_at
		FROM setup_state WHERE id = 1
	`)
	st := &State{}
	var started, completed, progressUpdated sqlNullTime
	var subStep, dataStr sql.NullString
	if err := row.Scan(&st.Status, &st.Nonce, &started, &completed, &st.CurrentStep, &subStep, &dataStr, &progressUpdated); err != nil {
		return nil, err
	}
	if started.Valid {
		st.StartedAt = &started.Time
	}
	if completed.Valid {
		st.CompletedAt = &completed.Time
	}
	if subStep.Valid {
		st.CurrentSubStep = subStep.String
	}
	if progressUpdated.Valid {
		st.ProgressUpdatedAt = &progressUpdated.Time
	}
	st.StepData = map[string]interface{}{}
	if dataStr.Valid && dataStr.String != "" {
		_ = json.Unmarshal([]byte(dataStr.String), &st.StepData)
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

func nullIfEmpty(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}
