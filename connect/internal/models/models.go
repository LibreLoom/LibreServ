package models

import (
	"database/sql"
	"fmt"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// Service provides AI provider and model configuration operations.
type Service struct {
	db *sql.DB
}

// NewService creates a models service.
func NewService(db *sql.DB) *Service {
	return &Service{db: db}
}

// Provider is an AI inference provider.
type Provider struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	BaseURL   string `json:"base_url"`
	APIKey    string `json:"api_key,omitempty"`
	Enabled   bool   `json:"enabled"`
	Tier      string `json:"tier"` // "paid" or "free"
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

// Model is an AI model with pricing.
type Model struct {
	ID                    string  `json:"id"`
	ProviderID            string  `json:"provider_id"`
	ModelID               string  `json:"model_id"`
	DisplayName           string  `json:"display_name"`
	Role                  string  `json:"role"` // "agent" or "review"
	InputPricePerMillion  float64 `json:"input_price_per_million"`
	OutputPricePerMillion float64 `json:"output_price_per_million"`
	CachePricePerMillion  float64 `json:"cache_price_per_million"`
	ContextWindow         int     `json:"context_window"`
	Enabled               bool    `json:"enabled"`
	SortOrder             int     `json:"sort_order"`
}

// FallbackChainEntry is one step in a role's fallback chain.
type FallbackChainEntry struct {
	Role     string `json:"role"`
	Tier     string `json:"tier"`
	ModelID  string `json:"model_id"`
	Priority int    `json:"priority"`
}

// ListProviders returns all AI providers.
func (s *Service) ListProviders() ([]Provider, error) {
	rows, err := s.db.Query(
		`SELECT id, name, base_url, api_key, enabled, tier, created_at, updated_at FROM ai_providers ORDER BY name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var providers []Provider
	for rows.Next() {
		var p Provider
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&p.ID, &p.Name, &p.BaseURL, &p.APIKey, &p.Enabled, &p.Tier, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		p.CreatedAt = createdAt.Format(time.RFC3339)
		p.UpdatedAt = updatedAt.Format(time.RFC3339)
		providers = append(providers, p)
	}
	return providers, nil
}

// GetProvider returns a single provider by ID.
func (s *Service) GetProvider(id string) (*Provider, error) {
	var p Provider
	var createdAt, updatedAt time.Time
	err := s.db.QueryRow(
		`SELECT id, name, base_url, api_key, enabled, tier, created_at, updated_at FROM ai_providers WHERE id = ?`, id).
		Scan(&p.ID, &p.Name, &p.BaseURL, &p.APIKey, &p.Enabled, &p.Tier, &createdAt, &updatedAt)
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p.CreatedAt = createdAt.Format(time.RFC3339)
	p.UpdatedAt = updatedAt.Format(time.RFC3339)
	return &p, nil
}

// CreateProvider creates a new AI provider.
func (s *Service) CreateProvider(name, baseURL, apiKey, tier string, enabled bool) (*Provider, error) {
	id := security.GenerateID("prov")
	now := time.Now()
	_, err := s.db.Exec(
		`INSERT INTO ai_providers (id, name, base_url, api_key, enabled, tier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		id, name, baseURL, apiKey, enabled, tier, now, now)
	if err != nil {
		return nil, err
	}
	return &Provider{ID: id, Name: name, BaseURL: baseURL, Enabled: enabled, Tier: tier, CreatedAt: now.Format(time.RFC3339), UpdatedAt: now.Format(time.RFC3339)}, nil
}

// UpdateProvider updates an existing provider.
func (s *Service) UpdateProvider(id, name, baseURL, apiKey, tier string, enabled bool) error {
	_, err := s.db.Exec(
		`UPDATE ai_providers SET name = ?, base_url = ?, api_key = ?, tier = ?, enabled = ?, updated_at = ? WHERE id = ?`,
		name, baseURL, apiKey, tier, enabled, time.Now(), id)
	return err
}

// DeleteProvider removes a provider (cascades to models).
func (s *Service) DeleteProvider(id string) error {
	_, err := s.db.Exec("DELETE FROM ai_providers WHERE id = ?", id)
	return err
}

// ListModels returns all AI models, optionally filtered by role.
func (s *Service) ListModels(role string) ([]Model, error) {
	var rows *sql.Rows
	var err error
	if role != "" {
		rows, err = s.db.Query(
			`SELECT id, provider_id, model_id, display_name, role, input_price_per_million, output_price_per_million,
			        cache_price_per_million, context_window, enabled, sort_order
			 FROM ai_models WHERE role = ? ORDER BY sort_order, display_name`, role)
	} else {
		rows, err = s.db.Query(
			`SELECT id, provider_id, model_id, display_name, role, input_price_per_million, output_price_per_million,
			        cache_price_per_million, context_window, enabled, sort_order
			 FROM ai_models ORDER BY sort_order, display_name`)
	}
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var models []Model
	for rows.Next() {
		var m Model
		if err := rows.Scan(&m.ID, &m.ProviderID, &m.ModelID, &m.DisplayName, &m.Role,
			&m.InputPricePerMillion, &m.OutputPricePerMillion, &m.CachePricePerMillion,
			&m.ContextWindow, &m.Enabled, &m.SortOrder); err != nil {
			return nil, err
		}
		models = append(models, m)
	}
	return models, nil
}

// CreateModel creates a new AI model.
func (s *Service) CreateModel(providerID, modelID, displayName, role string, inputPrice, outputPrice, cachePrice float64, contextWindow int, enabled bool, sortOrder int) (*Model, error) {
	id := security.GenerateID("model")
	_, err := s.db.Exec(
		`INSERT INTO ai_models (id, provider_id, model_id, display_name, role, input_price_per_million, output_price_per_million, cache_price_per_million, context_window, enabled, sort_order, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		id, providerID, modelID, displayName, role, inputPrice, outputPrice, cachePrice, contextWindow, enabled, sortOrder, time.Now(), time.Now())
	if err != nil {
		return nil, err
	}
	return &Model{ID: id, ProviderID: providerID, ModelID: modelID, DisplayName: displayName, Role: role,
		InputPricePerMillion: inputPrice, OutputPricePerMillion: outputPrice, CachePricePerMillion: cachePrice,
		ContextWindow: contextWindow, Enabled: enabled, SortOrder: sortOrder}, nil
}

// UpdateModel updates an existing model.
func (s *Service) UpdateModel(id, modelID, displayName, role string, inputPrice, outputPrice, cachePrice float64, contextWindow int, enabled bool, sortOrder int) error {
	_, err := s.db.Exec(
		`UPDATE ai_models SET model_id = ?, display_name = ?, role = ?, input_price_per_million = ?, output_price_per_million = ?, cache_price_per_million = ?, context_window = ?, enabled = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
		modelID, displayName, role, inputPrice, outputPrice, cachePrice, contextWindow, enabled, sortOrder, time.Now(), id)
	return err
}

// DeleteModel removes a model.
func (s *Service) DeleteModel(id string) error {
	_, err := s.db.Exec("DELETE FROM ai_models WHERE id = ?", id)
	return err
}

// GetFallbackChain returns the ordered fallback chain for a role and tier.
func (s *Service) GetFallbackChain(role, tier string) ([]Model, error) {
	rows, err := s.db.Query(
		`SELECT m.id, m.provider_id, m.model_id, m.display_name, m.role,
		        m.input_price_per_million, m.output_price_per_million, m.cache_price_per_million,
		        m.context_window, m.enabled, m.sort_order
		 FROM ai_fallback_chains fc
		 JOIN ai_models m ON fc.model_id = m.id
		 WHERE fc.role = ? AND fc.tier = ? AND m.enabled = 1
		 ORDER BY fc.priority`, role, tier)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var models []Model
	for rows.Next() {
		var m Model
		if err := rows.Scan(&m.ID, &m.ProviderID, &m.ModelID, &m.DisplayName, &m.Role,
			&m.InputPricePerMillion, &m.OutputPricePerMillion, &m.CachePricePerMillion,
			&m.ContextWindow, &m.Enabled, &m.SortOrder); err != nil {
			return nil, err
		}
		models = append(models, m)
	}
	return models, nil
}

// SetFallbackChain replaces the fallback chain for a role/tier.
func (s *Service) SetFallbackChain(role, tier string, modelIDs []string) error {
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	_, err = tx.Exec("DELETE FROM ai_fallback_chains WHERE role = ? AND tier = ?", role, tier)
	if err != nil {
		return err
	}

	for i, modelID := range modelIDs {
		_, err = tx.Exec(
			`INSERT OR IGNORE INTO ai_fallback_chains (role, tier, model_id, priority) VALUES (?, ?, ?, ?)`,
			role, tier, modelID, i)
		if err != nil {
			return err
		}
	}

	return tx.Commit()
}

// ResolveModelForDevice returns the first available model for a device's plan tier.
// Free plan uses "free" tier, paid plans use "paid" tier.
func (s *Service) ResolveModelForDevice(role, planID string) (*Model, error) {
	tier := "paid"
	if planID == "free" {
		tier = "free"
	}

	chain, err := s.GetFallbackChain(role, tier)
	if err != nil {
		return nil, err
	}
	if len(chain) > 0 {
		return &chain[0], nil
	}

	// Fallback: return first enabled model for this role
	models, err := s.ListModels(role)
	if err != nil {
		return nil, err
	}
	for i := range models {
		if models[i].Enabled {
			return &models[i], nil
		}
	}

	return nil, fmt.Errorf("no enabled model found for role %s", role)
}

// ResolveProvider returns the provider for a model.
func (s *Service) ResolveProvider(model *Model) (*Provider, error) {
	return s.GetProvider(model.ProviderID)
}
