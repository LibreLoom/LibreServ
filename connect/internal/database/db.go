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
	service_type TEXT NOT NULL,
	metric TEXT NOT NULL,
	value REAL NOT NULL DEFAULT 0,
	cost_usd REAL NOT NULL DEFAULT 0,
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

INSERT OR IGNORE INTO plans (id, name, description, price_monthly_cents, limits_json) VALUES
('free', 'Connect Free', 'Get started with basic services. No credit card required.', 0,
 '{"max_emails_per_day":30,"tunnel_mbps":1,"tunnel_gb_per_mo":1,"ai_messages_per_mo":50,"backup_gb":0}'),
('one', 'Connect One', 'All services, unlimited. Fixed monthly price.', 1500,
 '{"max_emails_per_day":0,"tunnel_mbps":100,"tunnel_gb_per_mo":0,"ai_messages_per_mo":0,"backup_gb":0}'),
('payg', 'Connect PAYG', 'All services, pay for what you use.', 0,
 '{"max_emails_per_day":0,"tunnel_mbps":100,"tunnel_gb_per_mo":0,"ai_messages_per_mo":0,"backup_gb":0}');

CREATE INDEX IF NOT EXISTS idx_devices_token ON devices(token_hash);
CREATE INDEX IF NOT EXISTS idx_devices_plan ON devices(plan_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_device ON subscriptions(device_id);
CREATE INDEX IF NOT EXISTS idx_credentials_device ON service_credentials(device_id);
CREATE INDEX IF NOT EXISTS idx_usage_device ON usage_events(device_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_cases_device ON support_cases(device_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON support_cases(status);
CREATE INDEX IF NOT EXISTS idx_messages_case ON case_messages(case_id);
CREATE INDEX IF NOT EXISTS idx_consent_case ON consent_requests(case_id);
		`,
	},
}
