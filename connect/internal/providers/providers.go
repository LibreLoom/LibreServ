package providers

import (
	"database/sql"
	"encoding/json"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
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
			 FROM service_providers WHERE service = $1 ORDER BY name`, service)
	} else {
		rows, err = s.db.Query(
			`SELECT id, service, name, credentials_json, settings_json, enabled, created_at, updated_at
			 FROM service_providers ORDER BY service, name`)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	providers := []Provider{}
	for rows.Next() {
		p, err := scanProvider(rows)
		if err != nil {
			return nil, err
		}
		providers = append(providers, p)
	}
	return providers, nil
}

// Get returns a single provider by ID.
func (s *Service) Get(id string) (*Provider, error) {
	row := s.db.QueryRow(
		`SELECT id, service, name, credentials_json, settings_json, enabled, created_at, updated_at
		 FROM service_providers WHERE id = $1`, id)
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
		 FROM service_providers WHERE service = $1 AND enabled = TRUE ORDER BY created_at LIMIT 1`, service)
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
	id := security.GenerateID("prov")
	now := time.Now()
	credJSON := mustJSONStringMap(credentials)
	settingsJSON := mustJSONStringMap(settings)
	_, err := s.db.Exec(
		`INSERT INTO service_providers (id, service, name, credentials_json, settings_json, enabled, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		id, service, name, credJSON, settingsJSON, enabled, now, now)
	if err != nil {
		return nil, err
	}
	return &Provider{
		ID: id, Service: service, Name: name,
		Credentials: copyStringMap(credentials),
		Settings:    copyStringMap(settings),
		Enabled:     enabled,
		CreatedAt:   now.Format(time.RFC3339),
		UpdatedAt:   now.Format(time.RFC3339),
	}, nil
}

// Update updates an existing provider.
func (s *Service) Update(id, service, name string, credentials, settings map[string]string, enabled bool) error {
	credJSON := mustJSONStringMap(credentials)
	settingsJSON := mustJSONStringMap(settings)
	_, err := s.db.Exec(
		`UPDATE service_providers
		 SET service = $1, name = $2, credentials_json = $3, settings_json = $4, enabled = $5, updated_at = $6
		 WHERE id = $7`,
		service, name, credJSON, settingsJSON, enabled, time.Now(), id)
	return err
}

// Delete removes a provider.
func (s *Service) Delete(id string) error {
	_, err := s.db.Exec("DELETE FROM service_providers WHERE id = $1", id)
	return err
}

type scanner interface {
	Scan(dest ...any) error
}

func scanProvider(row scanner) (Provider, error) {
	var p Provider
	var credJSON, settingsJSON string
	var createdAt, updatedAt time.Time
	if err := row.Scan(&p.ID, &p.Service, &p.Name, &credJSON, &settingsJSON, &p.Enabled, &createdAt, &updatedAt); err != nil {
		return Provider{}, err
	}
	p.CreatedAt = createdAt.Format(time.RFC3339)
	p.UpdatedAt = updatedAt.Format(time.RFC3339)
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
