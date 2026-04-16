package network

import (
	"context"
	"database/sql"
	"fmt"
	"net/netip"
	"time"

	"github.com/google/uuid"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

type DNSProviderManager struct {
	db *database.DB
}

func NewDNSProviderManager(db *database.DB) *DNSProviderManager {
	return &DNSProviderManager{db: db}
}

func parseTimestamp(s string) time.Time {
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		t, err = time.Parse("2006-01-02 15:04:05-07:00", s)
	}
	if err != nil {
		t, _ = time.Parse("2006-01-02 15:04:05", s)
	}
	if t.IsZero() && s != "" {
		t = time.Now().UTC()
	}
	return t
}

func (m *DNSProviderManager) GetConfig(ctx context.Context) (*DNSProviderConfig, error) {
	row := m.db.QueryRowContext(ctx,
		`SELECT id, provider, domain, api_token, enabled, created_at, updated_at
		 FROM dns_provider_configs
		 WHERE enabled = TRUE
		 ORDER BY updated_at DESC
		 LIMIT 1`,
	)
	var cfg DNSProviderConfig
	var createdAt, updatedAt string
	if err := row.Scan(&cfg.ID, &cfg.Provider, &cfg.Domain, &cfg.APIToken, &cfg.Enabled, &createdAt, &updatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, nil
		}
		return nil, fmt.Errorf("get dns provider config: %w", err)
	}
	cfg.CreatedAt = parseTimestamp(createdAt)
	cfg.UpdatedAt = parseTimestamp(updatedAt)
	return &cfg, nil
}

func (m *DNSProviderManager) SaveConfig(ctx context.Context, cfg *DNSProviderConfig) error {
	if cfg.ID == "" {
		cfg.ID = uuid.NewString()
	}
	now := time.Now().UTC()
	nowStr := now.Format(time.RFC3339)

	if cfg.CreatedAt.IsZero() {
		cfg.CreatedAt = now
	}
	cfg.UpdatedAt = now

	_, err := m.db.ExecContext(ctx,
		`INSERT INTO dns_provider_configs (id, provider, domain, api_token, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		     provider = excluded.provider,
		     domain = excluded.domain,
		     api_token = excluded.api_token,
		     enabled = excluded.enabled,
		     updated_at = excluded.updated_at`,
		cfg.ID, cfg.Provider, cfg.Domain, cfg.APIToken, cfg.Enabled, nowStr, nowStr,
	)
	if err != nil {
		return fmt.Errorf("save dns provider config: %w", err)
	}
	return nil
}

func (m *DNSProviderManager) NewProvider(cfg *DNSProviderConfig) (DNSProvider, error) {
	switch cfg.Provider {
	case ProviderCloudflare:
		return NewCloudflareProvider(cfg.APIToken), nil
	default:
		return nil, fmt.Errorf("unsupported dns provider: %s", cfg.Provider)
	}
}

func (m *DNSProviderManager) ValidateCredentials(ctx context.Context, cfg *DNSProviderConfig) error {
	p, err := m.NewProvider(cfg)
	if err != nil {
		return err
	}
	return p.Validate(ctx, cfg.Zone())
}

const defaultDNSTTL = 5 * time.Minute

func (m *DNSProviderManager) SetupWildcardDNS(ctx context.Context, cfg *DNSProviderConfig, ip netip.Addr) error {
	p, err := m.NewProvider(cfg)
	if err != nil {
		return err
	}
	zone := cfg.Zone()
	if zone == "" {
		return fmt.Errorf("zone is required")
	}
	s := p.Records()
	if err := SetARecord(ctx, s, zone, "", ip, defaultDNSTTL); err != nil {
		return fmt.Errorf("set apex A record: %w", err)
	}
	if err := SetARecord(ctx, s, zone, "*", ip, defaultDNSTTL); err != nil {
		return fmt.Errorf("set wildcard A record: %w", err)
	}
	return nil
}
