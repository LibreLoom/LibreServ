package agent

import (
	"context"
	"sync"
	"time"
)

type ModelRegistry struct {
	provider *Provider
	models   []ModelInfo
	fetched  time.Time
	mu       sync.RWMutex
	ttl      time.Duration
}

func NewModelRegistry(provider *Provider) *ModelRegistry {
	return &ModelRegistry{
		provider: provider,
		ttl:      1 * time.Hour,
	}
}

func (m *ModelRegistry) List(ctx context.Context) ([]ModelInfo, error) {
	m.mu.RLock()
	if m.models != nil && time.Since(m.fetched) < m.ttl {
		result := m.models
		m.mu.RUnlock()
		return result, nil
	}
	m.mu.RUnlock()

	if m.provider == nil {
		return nil, nil
	}

	models, err := m.provider.Models(ctx)
	if err != nil {
		m.mu.RLock()
		if m.models != nil {
			result := m.models
			m.mu.RUnlock()
			return result, nil
		}
		m.mu.RUnlock()
		return nil, err
	}

	m.mu.Lock()
	m.models = models
	m.fetched = time.Now()
	m.mu.Unlock()

	return models, nil
}

func (m *ModelRegistry) Refresh(ctx context.Context) error {
	if m.provider == nil {
		return nil
	}
	models, err := m.provider.Models(ctx)
	if err != nil {
		return err
	}
	m.mu.Lock()
	m.models = models
	m.fetched = time.Now()
	m.mu.Unlock()
	return nil
}
