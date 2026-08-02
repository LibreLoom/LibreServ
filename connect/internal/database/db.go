package database

import (
	"database/sql"
	"fmt"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// DB holds the application database connection.
var DB *sql.DB

func Open(url string) (*sql.DB, error) {
	db, err := sql.Open("pgx", url)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(25)
	db.SetMaxIdleConns(5)
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
CREATE TABLE IF NOT EXISTS customer_accounts (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	name TEXT,
	plan_id TEXT NOT NULL DEFAULT 'free',
	totp_secret TEXT,
	totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
	is_active BOOLEAN NOT NULL DEFAULT TRUE,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS devices (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
	connect_key_id TEXT,
	plan_id TEXT NOT NULL DEFAULT 'free',
	activated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	last_seen_at TIMESTAMP,
	metadata_json TEXT DEFAULT '{}',
	is_active BOOLEAN NOT NULL DEFAULT TRUE,
	subdomain TEXT,
	UNIQUE(subdomain)
);

CREATE TABLE IF NOT EXISTS connect_keys (
	id TEXT PRIMARY KEY,
	key_hash TEXT NOT NULL UNIQUE,
	key_prefix TEXT NOT NULL,
	account_id TEXT NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
	plan_id TEXT NOT NULL DEFAULT 'free',
	device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
	status TEXT NOT NULL DEFAULT 'unused' CHECK(status IN ('unused','active','revoked','expired')),
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	activated_at TIMESTAMP,
	expires_at TIMESTAMP
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
	started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	ends_at TIMESTAMP,
	stripe_subscription_id TEXT,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE(device_id)
);

CREATE TABLE IF NOT EXISTS service_credentials (
	id TEXT PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	service_type TEXT NOT NULL,
	credentials_json TEXT NOT NULL DEFAULT '{}',
	provisioned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	revoked_at TIMESTAMP,
	is_active BOOLEAN NOT NULL DEFAULT TRUE,
	UNIQUE(device_id, service_type)
);

CREATE TABLE IF NOT EXISTS usage_events (
	id SERIAL PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	plan_id TEXT NOT NULL DEFAULT 'free',
	service_type TEXT NOT NULL,
	metric TEXT NOT NULL,
	value DOUBLE PRECISION NOT NULL DEFAULT 0,
	cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
	credits_consumed DOUBLE PRECISION NOT NULL DEFAULT 0,
	provider_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
	metadata_json TEXT DEFAULT '{}',
	timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS billing_cycles (
	id TEXT PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	start_date DATE NOT NULL,
	end_date DATE NOT NULL,
	total_cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
	credit_cap_usd DOUBLE PRECISION,
	status TEXT NOT NULL DEFAULT 'open',
	stripe_invoice_id TEXT,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS account_credits (
	id TEXT PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	balance_cents INTEGER NOT NULL DEFAULT 0,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS credit_transactions (
	id SERIAL PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	amount_cents INTEGER NOT NULL,
	direction TEXT NOT NULL CHECK(direction IN ('credit','debit')),
	reason TEXT NOT NULL,
	reference_id TEXT,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS invoices (
	id TEXT PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	stripe_invoice_id TEXT,
	status TEXT NOT NULL DEFAULT 'draft',
	amount_cents INTEGER NOT NULL DEFAULT 0,
	period_start DATE NOT NULL,
	period_end DATE NOT NULL,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	paid_at TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_providers (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL UNIQUE,
	base_url TEXT NOT NULL,
	api_key TEXT NOT NULL,
	enabled BOOLEAN NOT NULL DEFAULT TRUE,
	tier TEXT NOT NULL DEFAULT 'paid',
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ai_models (
	id TEXT PRIMARY KEY,
	provider_id TEXT NOT NULL REFERENCES ai_providers(id) ON DELETE CASCADE,
	model_id TEXT NOT NULL,
	display_name TEXT NOT NULL,
	role TEXT NOT NULL DEFAULT 'agent',
	input_price_per_million DOUBLE PRECISION NOT NULL DEFAULT 0,
	output_price_per_million DOUBLE PRECISION NOT NULL DEFAULT 0,
	cache_price_per_million DOUBLE PRECISION NOT NULL DEFAULT 0,
	context_window INTEGER NOT NULL DEFAULT 0,
	enabled BOOLEAN NOT NULL DEFAULT TRUE,
	sort_order INTEGER NOT NULL DEFAULT 0,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE(provider_id, model_id)
);

CREATE TABLE IF NOT EXISTS ai_fallback_chains (
	id SERIAL PRIMARY KEY,
	role TEXT NOT NULL,
	tier TEXT NOT NULL DEFAULT 'paid',
	model_id TEXT NOT NULL REFERENCES ai_models(id) ON DELETE CASCADE,
	priority INTEGER NOT NULL DEFAULT 0,
	UNIQUE(role, tier, model_id)
);

CREATE TABLE IF NOT EXISTS support_cases (
	id TEXT PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	summary TEXT NOT NULL,
	session_code TEXT,
	contact TEXT,
	status TEXT NOT NULL DEFAULT 'open',
	scopes_json TEXT NOT NULL DEFAULT '[]',
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS case_messages (
	id SERIAL PRIMARY KEY,
	case_id TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
	author TEXT NOT NULL,
	text TEXT NOT NULL,
	timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS consent_requests (
	id TEXT PRIMARY KEY,
	case_id TEXT NOT NULL REFERENCES support_cases(id) ON DELETE CASCADE,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	requested_by TEXT NOT NULL,
	path TEXT NOT NULL,
	scope_type TEXT NOT NULL CHECK(scope_type IN ('file','directory','credential')),
	status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','granted','denied','expired')),
	requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	responded_at TIMESTAMP,
	expires_at TIMESTAMP,
	notes TEXT
);

CREATE TABLE IF NOT EXISTS admin_accounts (
	id TEXT PRIMARY KEY,
	email TEXT NOT NULL UNIQUE,
	password_hash TEXT NOT NULL,
	name TEXT,
	totp_secret TEXT,
	totp_enabled BOOLEAN NOT NULL DEFAULT FALSE,
	is_active BOOLEAN NOT NULL DEFAULT TRUE,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_providers (
	id TEXT PRIMARY KEY,
	service TEXT NOT NULL,
	name TEXT NOT NULL,
	credentials_json TEXT NOT NULL DEFAULT '{}',
	settings_json TEXT NOT NULL DEFAULT '{}',
	enabled BOOLEAN NOT NULL DEFAULT TRUE,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE(service, name)
);
CREATE INDEX IF NOT EXISTS idx_providers_service ON service_providers(service);
CREATE TABLE IF NOT EXISTS custom_domains (
	id TEXT PRIMARY KEY,
	device_id TEXT REFERENCES devices(id) ON DELETE CASCADE,
	domain TEXT NOT NULL UNIQUE,
	registered_via TEXT NOT NULL DEFAULT 'cloudflare',
	registration_cost_cents INTEGER,
	auto_renew BOOLEAN NOT NULL DEFAULT FALSE,
	renewal_subscription_id TEXT,
	status TEXT NOT NULL DEFAULT 'active',
	purchased_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	expires_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_custom_domains_device ON custom_domains(device_id);
CREATE INDEX IF NOT EXISTS idx_custom_domains_domain ON custom_domains(domain);

CREATE TABLE IF NOT EXISTS device_routes (
	id TEXT PRIMARY KEY,
	device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
	hostname TEXT NOT NULL,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	UNIQUE(device_id, hostname)
);
CREATE INDEX IF NOT EXISTS idx_device_routes_device ON device_routes(device_id);
CREATE INDEX IF NOT EXISTS idx_device_routes_hostname ON device_routes(hostname);

CREATE TABLE IF NOT EXISTS audit_logs (
	id SERIAL PRIMARY KEY,
	actor TEXT NOT NULL,
	action TEXT NOT NULL,
	target_type TEXT NOT NULL,
	target_id TEXT,
	details_json TEXT DEFAULT '{}',
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS customer_sessions (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
	token_hash TEXT NOT NULL UNIQUE,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	expires_at TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_sessions (
	id TEXT PRIMARY KEY,
	admin_id TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
	token_hash TEXT NOT NULL UNIQUE,
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
	expires_at TIMESTAMP NOT NULL
);


INSERT INTO plans (id, name, description, price_monthly_cents, limits_json) VALUES
('free', 'Connect Free', 'Get started with basic services. No credit card required.', 0,
 '{"backup_gb":0,"ai_credit_cents":0,"tunnel_gb":0,"smtp_monthly":30,"ai_messages_per_day":50,"domain":"*.free.servers.libreloom.org","human_support":false}'),
('lite', 'Connect Base', 'All services with a generous monthly allowance. Pay only for overage.', 600,
 '{"backup_gb":100,"ai_credit_cents":200,"tunnel_gb":50,"smtp_monthly":250,"domain":"*.servers.libreloom.org","human_support":true}'),
('one', 'Connect One', 'Everything included with the largest allowance. Best value for active users.', 2500,
 '{"backup_gb":1024,"ai_credit_cents":500,"tunnel_gb":200,"smtp_monthly":2500,"domain":"*.servers.libreloom.org","human_support":true}')
ON CONFLICT (id) DO UPDATE SET
	name = EXCLUDED.name,
	description = EXCLUDED.description,
	price_monthly_cents = EXCLUDED.price_monthly_cents,
	limits_json = EXCLUDED.limits_json;

CREATE INDEX IF NOT EXISTS idx_connect_keys_hash ON connect_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_connect_keys_account ON connect_keys(account_id);
CREATE INDEX IF NOT EXISTS idx_connect_keys_status ON connect_keys(status);
CREATE INDEX IF NOT EXISTS idx_devices_connect_key ON devices(connect_key_id);
CREATE INDEX IF NOT EXISTS idx_customer_accounts_email ON customer_accounts(email);
CREATE INDEX IF NOT EXISTS idx_devices_account ON devices(account_id);
CREATE INDEX IF NOT EXISTS idx_devices_plan ON devices(plan_id);
CREATE INDEX IF NOT EXISTS idx_subscriptions_device ON subscriptions(device_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscriptions_device_unique ON subscriptions(device_id);
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
CREATE INDEX IF NOT EXISTS idx_audit_target ON audit_logs(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_customer_sessions_account ON customer_sessions(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_connect_keys_account_unique ON connect_keys(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_account_unique ON devices(account_id);
CREATE INDEX IF NOT EXISTS idx_customer_accounts_plan ON customer_accounts(plan_id);
		`,
	},
	{
		name: "002_email_verification",
		sql: `
ALTER TABLE customer_accounts ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE IF NOT EXISTS email_verification_tokens (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL REFERENCES customer_accounts(id) ON DELETE CASCADE,
	token_hash TEXT NOT NULL UNIQUE,
	expires_at TIMESTAMP NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours'),
	created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_verif_account ON email_verification_tokens(account_id);
		`,
	},
	{
		name: "003_username_and_smtp",
		sql: `
ALTER TABLE customer_accounts ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE customer_accounts ADD COLUMN IF NOT EXISTS smtp_password TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_customer_accounts_username ON customer_accounts(username) WHERE username IS NOT NULL;
		`,
	},
	{
		name: "004_domain_renewal",
		sql: `
ALTER TABLE custom_domains ADD COLUMN IF NOT EXISTS renewal_cost_cents INTEGER;
ALTER TABLE custom_domains ADD COLUMN IF NOT EXISTS grace_until TIMESTAMP;
		`,
	},
	{
		name: "005_device_subdomain",
		sql: `
ALTER TABLE devices ADD COLUMN IF NOT EXISTS subdomain TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_subdomain_unique ON devices(subdomain);
		`,
	},
	{
		name: "006_cancel_at_period_end",
		sql: `
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE;
		`,
	},
	{
		name: "007_domain_account_id",
		sql: `
ALTER TABLE custom_domains ADD COLUMN IF NOT EXISTS account_id TEXT REFERENCES customer_accounts(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS idx_custom_domains_account ON custom_domains(account_id);
		`,
	},
}
