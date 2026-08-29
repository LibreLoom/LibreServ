package providers

import (
	"database/sql"
	"encoding/json"
	"time"

	"gt.plainskill.net/LibreLoom/LunaConnect/internal/security"
)

// Service provides service provider configuration operations.
type Service struct {
	db *sql.DB
}

// NewService creates a providers service.
func NewService(db *sql.DB) *Service {
	return &Service{db: db}
}

// Provider is a configurable upstream service provider.
type Provider struct {
	ID          string            `json:"id"`
	Service     string            `json:"service"`
	Name        string            `json:"name"`
	Credentials map[string]string `json:"credentials"`
	Settings    map[string]string `json:"settings"`
	Enabled     bool              `json:"enabled"`
	CreatedAt   string            `json:"created_at"`
	UpdatedAt   string            `json:"updated_at"`
}

// List returns providers, optionally filtered by service.
func (s *Service) List(service string) ([]Provider, error) {
	var rows *sql.Rows
	var err error
	if service != "" {
		rows, err = s.db.Query(
			`SELECT id, service, name, credentials_json, settings_json, enabled, created_at, updated_at
			 FROM service_providers WHERE service = ? ORDER BY name`, service)
	} else {
		rows, err = s.db.Query(
			`SELECT id, service, name, credentials_json, settings_json, enabled, created_at, updated_at
			 FROM service_providers ORDER BY service, name`)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Provider{}
	for rows.Next() {
		p, err := scanProvider(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, nil
}

// Get returns a single provider by ID.
func (s *Service) Get(id string) (*Provider, error) {
	row := s.db.QueryRow(
		`SELECT id, service, name, credentials_json, settings_json, enabled, created_at, updated_at
		 FROM service_providers WHERE id = ?`, id)
	p, err := scanProvider(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// FindEnabled returns the first enabled provider for a service.
func (s *Service) FindEnabled(service string) (*Provider, error) {
	row := s.db.QueryRow(
		`SELECT id, service, name, credentials_json, settings_json, enabled, created_at, updated_at
		 FROM service_providers WHERE service = ? AND enabled = 1 ORDER BY created_at LIMIT 1`, service)
	p, err := scanProvider(row)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

// Create creates a new provider.
func (s *Service) Create(service, name string, credentials, settings map[string]string, enabled bool) (*Provider, error) {
	id := security.NewID("prov")
	now := time.Now().Unix()
	credJSON := mustJSONStringMap(credentials)
	settingsJSON := mustJSONStringMap(settings)
	_, err := s.db.Exec(
		`INSERT INTO service_providers (id, service, name, credentials_json, settings_json, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, service, name, credJSON, settingsJSON, boolToInt(enabled), now, now)
	if err != nil {
		return nil, err
	}
	return &Provider{
		ID: id, Service: service, Name: name,
		Credentials: copyStringMap(credentials),
		Settings:    copyStringMap(settings),
		Enabled:     enabled,
		CreatedAt:   formatUnix(now),
		UpdatedAt:   formatUnix(now),
	}, nil
}

// Update updates an existing provider. Empty credential values keep the previous secret.
func (s *Service) Update(id, service, name string, credentials, settings map[string]string, enabled bool) error {
	existing, err := s.Get(id)
	if err != nil {
		return err
	}
	if existing == nil {
		return sql.ErrNoRows
	}
	merged := copyStringMap(existing.Credentials)
	for k, v := range credentials {
		if v != "" {
			merged[k] = v
		}
	}
	if settings == nil {
		settings = map[string]string{}
	}
	now := time.Now().Unix()
	_, err = s.db.Exec(
		`UPDATE service_providers
		 SET service = ?, name = ?, credentials_json = ?, settings_json = ?, enabled = ?, updated_at = ?
		 WHERE id = ?`,
		service, name, mustJSONStringMap(merged), mustJSONStringMap(settings), boolToInt(enabled), now, id)
	return err
}

// Delete removes a provider.
func (s *Service) Delete(id string) error {
	_, err := s.db.Exec(`DELETE FROM service_providers WHERE id = ?`, id)
	return err
}

type scanner interface {
	Scan(dest ...any) error
}

func scanProvider(row scanner) (Provider, error) {
	var p Provider
	var credJSON, settingsJSON string
	var enabled int
	var createdAt, updatedAt int64
	if err := row.Scan(&p.ID, &p.Service, &p.Name, &credJSON, &settingsJSON, &enabled, &createdAt, &updatedAt); err != nil {
		return Provider{}, err
	}
	p.Enabled = enabled != 0
	p.CreatedAt = formatUnix(createdAt)
	p.UpdatedAt = formatUnix(updatedAt)
	p.Credentials = parseStringMap(credJSON)
	p.Settings = parseStringMap(settingsJSON)
	return p, nil
}

func mustJSONStringMap(m map[string]string) string {
	if m == nil {
		m = map[string]string{}
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func parseStringMap(s string) map[string]string {
	m := map[string]string{}
	if s == "" {
		return m
	}
	_ = json.Unmarshal([]byte(s), &m)
	return m
}

func copyStringMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func boolToInt(v bool) int {
	if v {
		return 1
	}
	return 0
}

func formatUnix(sec int64) string {
	return time.Unix(sec, 0).UTC().Format(time.RFC3339)
}

// Credential returns a single credential value or the fallback.
func (p *Provider) Credential(key, fallback string) string {
	if p == nil || p.Credentials == nil {
		return fallback
	}
	if v, ok := p.Credentials[key]; ok && v != "" {
		return v
	}
	return fallback
}

// Setting returns a single setting value or the fallback.
func (p *Provider) Setting(key, fallback string) string {
	if p == nil || p.Settings == nil {
		return fallback
	}
	if v, ok := p.Settings[key]; ok && v != "" {
		return v
	}
	return fallback
}
