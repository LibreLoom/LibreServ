package relay

import (
	"database/sql"
	"fmt"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServConnect/internal/security"
)

// Service provides relay region management operations.
type Service struct {
	db *sql.DB
}

// NewService creates a relay service.
func NewService(db *sql.DB) *Service {
	return &Service{db: db}
}

// Region is a tunnel relay node.
type Region struct {
	ID         string  `json:"id"`
	Name       string  `json:"name"`
	Provider   string  `json:"provider"`
	Region     string  `json:"region"`
	Host       string  `json:"host"`
	CapacityGB int     `json:"capacity_gb"`
	UsedGB     float64 `json:"used_gb"`
	IsPremium  bool    `json:"is_premium"`
	IsHealthy  bool    `json:"is_healthy"`
	CreatedAt  string  `json:"created_at"`
	UpdatedAt  string  `json:"updated_at"`
}

// ListRegions returns all relay regions.
func (s *Service) ListRegions() ([]Region, error) {
	rows, err := s.db.Query(
		`SELECT id, name, provider, region, host, capacity_gb, used_gb, is_premium, is_healthy, created_at, updated_at
		 FROM relay_regions ORDER BY provider, region`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var regions []Region
	for rows.Next() {
		var r Region
		var createdAt, updatedAt time.Time
		if err := rows.Scan(&r.ID, &r.Name, &r.Provider, &r.Region, &r.Host,
			&r.CapacityGB, &r.UsedGB, &r.IsPremium, &r.IsHealthy, &createdAt, &updatedAt); err != nil {
			return nil, err
		}
		r.CreatedAt = createdAt.Format(time.RFC3339)
		r.UpdatedAt = updatedAt.Format(time.RFC3339)
		regions = append(regions, r)
	}
	return regions, nil
}

// CreateRegion adds a new relay region.
func (s *Service) CreateRegion(name, provider, region, host string, capacityGB int, isPremium bool) (*Region, error) {
	id := security.GenerateID("relay")
	now := time.Now()
	_, err := s.db.Exec(
		`INSERT INTO relay_regions (id, name, provider, region, host, capacity_gb, used_gb, is_premium, is_healthy, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, $6, 0, $7, 1, $8, $9)`,
		id, name, provider, region, host, capacityGB, isPremium, now, now)
	if err != nil {
		return nil, err
	}
	return &Region{
		ID: id, Name: name, Provider: provider, Region: region, Host: host,
		CapacityGB: capacityGB, IsPremium: isPremium, IsHealthy: true,
		CreatedAt: now.Format(time.RFC3339), UpdatedAt: now.Format(time.RFC3339),
	}, nil
}

// UpdateRegionHealth updates the health status of a relay region.
func (s *Service) UpdateRegionHealth(id string, isHealthy bool) error {
	_, err := s.db.Exec(
		`UPDATE relay_regions SET is_healthy = $1, updated_at = $2 WHERE id = $3`,
		isHealthy, time.Now(), id)
	return err
}

// UpdateRegionUsage records current bandwidth usage for a relay region.
func (s *Service) UpdateRegionUsage(id string, usedGB float64) error {
	_, err := s.db.Exec(
		`UPDATE relay_regions SET used_gb = $1, updated_at = $2 WHERE id = $3`,
		usedGB, time.Now(), id)
	return err
}

// DeleteRegion removes a relay region.
func (s *Service) DeleteRegion(id string) error {
	_, err := s.db.Exec("DELETE FROM relay_regions WHERE id = $1", id)
	return err
}

// AssignRelay picks the best available relay for a device.
// Premium plans get premium relays; free plan gets non-premium fallback.
func (s *Service) AssignRelay(planID string) (*Region, error) {
	wantPremium := planID != "free"

	var r Region
	var createdAt, updatedAt time.Time

	query := `SELECT id, name, provider, region, host, capacity_gb, used_gb, is_premium, is_healthy, created_at, updated_at
		  FROM relay_regions WHERE is_healthy = 1 AND is_premium = $1 AND used_gb < capacity_gb
		  ORDER BY (used_gb / capacity_gb) ASC LIMIT 1`
	err := s.db.QueryRow(query, wantPremium).Scan(
		&r.ID, &r.Name, &r.Provider, &r.Region, &r.Host,
		&r.CapacityGB, &r.UsedGB, &r.IsPremium, &r.IsHealthy, &createdAt, &updatedAt)
	if err == sql.ErrNoRows {
		// Fall back to any healthy relay
		err = s.db.QueryRow(
			`SELECT id, name, provider, region, host, capacity_gb, used_gb, is_premium, is_healthy, created_at, updated_at
			 FROM relay_regions WHERE is_healthy = 1 AND used_gb < capacity_gb
			 ORDER BY (used_gb / capacity_gb) ASC LIMIT 1`).Scan(
			&r.ID, &r.Name, &r.Provider, &r.Region, &r.Host,
			&r.CapacityGB, &r.UsedGB, &r.IsPremium, &r.IsHealthy, &createdAt, &updatedAt)
		if err == sql.ErrNoRows {
			return nil, fmt.Errorf("no healthy relay regions available")
		}
	}
	if err != nil {
		return nil, err
	}

	r.CreatedAt = createdAt.Format(time.RFC3339)
	r.UpdatedAt = updatedAt.Format(time.RFC3339)
	return &r, nil
}

// FleetStatus returns a summary of the relay fleet.
type FleetStatus struct {
	TotalNodes      int                       `json:"total_nodes"`
	HealthyNodes    int                       `json:"healthy_nodes"`
	PremiumNodes    int                       `json:"premium_nodes"`
	TotalCapacityGB int                       `json:"total_capacity_gb"`
	TotalUsedGB     float64                   `json:"total_used_gb"`
	Providers       map[string]ProviderStatus `json:"providers"`
}

// ProviderStatus is per-provider relay stats.
type ProviderStatus struct {
	Nodes    int     `json:"nodes"`
	Capacity int     `json:"capacity_gb"`
	Used     float64 `json:"used_gb"`
}

// GetFleetStatus returns aggregated relay fleet status.
func (s *Service) GetFleetStatus() (*FleetStatus, error) {
	status := &FleetStatus{Providers: make(map[string]ProviderStatus)}

	rows, err := s.db.Query(
		`SELECT provider, is_healthy, is_premium, capacity_gb, used_gb FROM relay_regions`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	for rows.Next() {
		var provider string
		var healthy, premium bool
		var capacity int
		var used float64
		if err := rows.Scan(&provider, &healthy, &premium, &capacity, &used); err != nil {
			return nil, err
		}
		status.TotalNodes++
		if healthy {
			status.HealthyNodes++
		}
		if premium {
			status.PremiumNodes++
		}
		status.TotalCapacityGB += capacity
		status.TotalUsedGB += used

		ps := status.Providers[provider]
		ps.Nodes++
		ps.Capacity += capacity
		ps.Used += used
		status.Providers[provider] = ps
	}

	return status, nil
}
