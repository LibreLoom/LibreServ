package database

import (
	"database/sql"
	"fmt"

	_ "github.com/mattn/go-sqlite3"
)

// DB holds the application database connection.
var DB *sql.DB

func Open(path string) (*sql.DB, error) {
	db, err := sql.Open("sqlite3", path+"?_journal=WAL&_fk=1")
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return db, nil
}

func Migrate(db *sql.DB) error {
	for _, m := range migrations {
		if _, err := db.Exec(m.sql); err != nil {
			return fmt.Errorf("migration %s: %w", m.name, err)
		}
	}
	return nil
}

type migration struct {
	name string
	sql  string
}

var migrations = []migration{
	{
		name: "001_init",
		sql: `
CREATE TABLE IF NOT EXISTS devices (
	id TEXT PRIMARY KEY,
	token_hash TEXT NOT NULL UNIQUE,
	plan_id TEXT NOT NULL DEFAULT 'free',
	activated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_seen_at DATETIME,
	metadata_json TEXT DEFAULT '{}',
	is_active BOOLEAN NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS plans (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	description TEXT NOT NULL,
	price_monthly_cents INTEGER NOT NULL DEFAULT 0,
	limits_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS subscriptions (
	id TEXT PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	plan_id TEXT NOT NULL REFERENCES plans(id),
	status TEXT NOT NULL DEFAULT 'active',
	started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	ends_at DATETIME,
	stripe_subscription_id TEXT,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_credentials (
	id TEXT PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	service_type TEXT NOT NULL,
	credentials_json TEXT NOT NULL DEFAULT '{}',
	provisioned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	revoked_at DATETIME,
	is_active BOOLEAN NOT NULL DEFAULT 1,
	UNIQUE(device_id, service_type)
);

CREATE TABLE IF NOT EXISTS usage_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	plan_id TEXT NOT NULL DEFAULT 'free',
	service_type TEXT NOT NULL,
	metric TEXT NOT NULL,
	value REAL NOT NULL DEFAULT 0,
	cost_usd REAL NOT NULL DEFAULT 0,
	credits_consumed REAL NOT NULL DEFAULT 0,
	provider_cost REAL NOT NULL DEFAULT 0,
	metadata_json TEXT DEFAULT '{}',
	timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS billing_cycles (
	id TEXT PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	start_date DATE NOT NULL,
	end_date DATE NOT NULL,
	total_cost_usd REAL NOT NULL DEFAULT 0,
	credit_cap_usd REAL,
	status TEXT NOT NULL DEFAULT 'open',
	stripe_invoice_id TEXT,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_credits (
	id TEXT PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	balance_cents INTEGER NOT NULL DEFAULT 0,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS credit_transactions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	amount_cents INTEGER NOT NULL,
	direction TEXT NOT NULL CHECK(direction IN ('credit','debit')),
	reason TEXT NOT NULL,
	reference_id TEXT,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoices (
	id TEXT PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	stripe_invoice_id TEXT,
	status TEXT NOT NULL DEFAULT 'draft',
	amount_cents INTEGER NOT NULL DEFAULT 0,
	period_start DATE NOT NULL,
	period_end DATE NOT NULL,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	paid_at DATETIME
);

CREATE TABLE IF NOT EXISTS ai_providers (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	base_url TEXT NOT NULL,
	api_key TEXT NOT NULL,
	enabled BOOLEAN NOT NULL DEFAULT 1,
	tier TEXT NOT NULL DEFAULT 'paid',
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_models (
	id TEXT PRIMARY KEY,
	provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
	model_id TEXT NOT NULL,
	display_name TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'agent',
	input_price_per_million REAL NOT NULL DEFAULT 0,
	output_price_per_million REAL NOT NULL DEFAULT 0,
	cache_price_per_million REAL NOT NULL DEFAULT 0,
	context_window INTEGER NOT NULL DEFAULT 0,
	enabled BOOLEAN NOT NULL DEFAULT 1,
	sort_order INTEGER NOT NULL DEFAULT 0,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE(provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS ai_fallback_chains (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	role TEXT NOT NULL,
	tier TEXT NOT NULL DEFAULT 'paid',
	model_id TEXT NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
	priority INTEGER NOT NULL DEFAULT 0,
	UNIQUE(role, tier, model_id)
);

CREATE TABLE IF NOT EXISTS relay_regions (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	provider TEXT NOT NULL,
	region TEXT NOT NULL,
	host TEXT NOT NULL,
	capacity_gb INTEGER NOT NULL DEFAULT 0,
	used_gb REAL NOT NULL DEFAULT 0,
	is_premium BOOLEAN NOT NULL DEFAULT 1,
	is_healthy BOOLEAN NOT NULL DEFAULT 1,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS support_cases (
	id TEXT PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	summary TEXT NOT NULL,
	session_code TEXT,
	contact TEXT,
	status TEXT NOT NULL DEFAULT 'open',
	scopes_json TEXT NOT NULL DEFAULT '[]',
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS case_messages (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	case_id TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
	author TEXT NOT NULL,
	text TEXT NOT NULL,
	timestamp DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS consent_requests (
	id TEXT PRIMARY KEY,
	case_id TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	requested_by TEXT NOT NULL,
	path TEXT NOT NULL,
	scope_type TEXT NOT NULL CHECK(scope_type IN ('file','directory','credential')),
	status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','granted','denied','expired')),
	requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	responded_at DATETIME,
	expires_at DATETIME,
	notes TEXT
);

CREATE TABLE IF NOT EXISTS admin_accounts (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	name TEXT,
	is_active BOOLEAN NOT NULL DEFAULT 1,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	actor TEXT NOT NULL,
	action TEXT NOT NULL,
	target_type TEXT NOT NULL,
	target_id TEXT,
	details_json TEXT DEFAULT '{}',
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customer_sessions (
	id TEXT PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	token_hash TEXT NOT NULL UNIQUE,
	created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
	expires_at DATETIME NOT NULL
);

INSERT OR REPLACE INTO plans (id, name, description, price_monthly_cents, limits_json) VALUES
('free', 'Connect Free', 'Get started with basic services. No credit card required.', 0,
 '{"backup_gb":0,"ai_credit_cents":0,"tunnel_gb":0,"smtp_monthly":30,"ai_messages_per_day":50,"domain":"*.free.servers.libreloom.org","human_support":false}'),
('lite', 'Connect Lite', 'All services with a generous monthly allowance. Pay only for overage.', 600,
 '{"backup_gb":100,"ai_credit_cents":200,"tunnel_gb":50,"smtp_monthly":250,"domain":"*.servers.libreloom.org","human_support":true}'),
('one', 'Connect One', 'Everything included with the largest allowance. Best value for active users.', 2500,
 '{"backup_gb":1024,"ai_credit_cents":500,"tunnel_gb":200,"smtp_monthly":2500,"domain":"*.servers.libreloom.org","human_support":true}');

CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token_hash);
CREATE INDEX IF NOT EXISTS idx_devices_plan ON devices(plan_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_device ON subscriptions(device_id);
CREATE INDEX IF NOT EXISTS idx_credentials_device ON service_credentials(device_id);
CREATE INDEX IF NOT EXISTS idx_usage_device ON usage_events(device_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_usage_plan ON usage_events(plan_id);
CREATE INDEX IF NOT EXISTS idx_cases_device ON support_cases(device_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON support_cases(status);
CREATE INDEX IF NOT EXISTS idx_messages_case ON case_messages(case_id);
CREATE INDEX IF NOT EXISTS idx_consent_case ON consent_requests(case_id);
CREATE INDEX IF NOT EXISTS idx_credits_device ON account_credits(device_id);
CREATE INDEX IF NOT EXISTS idx_credit_tx_device ON credit_transactions(device_id);
CREATE INDEX IF NOT EXISTS idx_invoices_device ON invoices(device_id);
CREATE INDEX IF NOT EXISTS idx_ai_models_provider ON ai_models(provider_id);
CREATE INDEX IF NOT EXISTS idx_ai_models_role ON ai_models(role);
CREATE INDEX IF NOT EXISTS idx_fallback_role ON ai_fallback_chains(role, tier);
CREATE INDEX IF NOT EXISTS idx_relay_provider ON relay_regions(provider);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor);
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_device ON customer_sessions(device_id);
		`,
	},
}
