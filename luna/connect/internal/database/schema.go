package database

const schemaSQLite = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_subscription_item_id TEXT,
  backup_quota_bytes INTEGER,
  has_card INTEGER NOT NULL DEFAULT 0,
  billing_status TEXT NOT NULL DEFAULT 'none',
  email_verified INTEGER NOT NULL DEFAULT 0,
  backup_purge_after INTEGER,
  purge_mail_day INTEGER,
  onboarding_path TEXT,
  onboarding_step TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_verif_account ON email_verification_tokens(account_id);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT,
  code_sealed TEXT,
  kind TEXT NOT NULL DEFAULT 'official',
  account_id TEXT,
  name TEXT,
  subdomain TEXT UNIQUE,
  tunnel_id TEXT,
  tunnel_token TEXT,
  setup_secret TEXT,
  local_port INTEGER NOT NULL DEFAULT 8090,
  last_seen_at INTEGER,
  order_ref TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(account_id) REFERENCES accounts(id)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS backup_objects (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_hash TEXT,
  storage_backend TEXT NOT NULL DEFAULT 'local',
  updated_at INTEGER NOT NULL,
  UNIQUE(account_id, device_id, relative_path)
);
CREATE TABLE IF NOT EXISTS backup_bindings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  archived_at INTEGER,
  archive_key TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(account_id, device_id)
);
CREATE TABLE IF NOT EXISTS register_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  start INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS guess_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  start INTEGER NOT NULL,
  last INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oss_payments (
  account_id TEXT PRIMARY KEY,
  payment_intent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  FOREIGN KEY(admin_id) REFERENCES admin_accounts(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS service_providers (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  name TEXT NOT NULL,
  credentials_json TEXT NOT NULL DEFAULT '{}',
  settings_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(service, name)
);
CREATE TABLE IF NOT EXISTS device_backup_buckets (
  device_id TEXT PRIMARY KEY,
  bucket_name TEXT NOT NULL UNIQUE,
  bucket_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  key_id TEXT NOT NULL,
  application_key_sealed TEXT NOT NULL,
  provisioned_at INTEGER NOT NULL,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS billing_storage_samples (
  account_id TEXT NOT NULL,
  period_ym TEXT NOT NULL,
  sampled_at INTEGER NOT NULL,
  stored_bytes INTEGER NOT NULL,
  PRIMARY KEY (account_id, sampled_at)
);
CREATE INDEX IF NOT EXISTS idx_billing_storage_period ON billing_storage_samples (account_id, period_ym);
CREATE TABLE IF NOT EXISTS billing_period_egress (
  account_id TEXT NOT NULL,
  period_ym TEXT NOT NULL,
  egress_bytes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, period_ym)
);
`

const schemaPostgres = `
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  stripe_subscription_item_id TEXT,
  backup_quota_bytes BIGINT,
  has_card INTEGER NOT NULL DEFAULT 0,
  billing_status TEXT NOT NULL DEFAULT 'none',
  email_verified INTEGER NOT NULL DEFAULT 0,
  backup_purge_after BIGINT,
  purge_mail_day INTEGER,
  onboarding_path TEXT,
  onboarding_step TEXT,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_verif_account ON email_verification_tokens(account_id);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT,
  code_sealed TEXT,
  kind TEXT NOT NULL DEFAULT 'official',
  account_id TEXT REFERENCES accounts(id),
  name TEXT,
  subdomain TEXT UNIQUE,
  tunnel_id TEXT,
  tunnel_token TEXT,
  setup_secret TEXT,
  local_port INTEGER NOT NULL DEFAULT 8090,
  last_seen_at BIGINT,
  order_ref TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS backup_objects (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  relative_path TEXT NOT NULL,
  size BIGINT NOT NULL,
  content_hash TEXT,
  storage_backend TEXT NOT NULL DEFAULT 'local',
  updated_at BIGINT NOT NULL,
  UNIQUE(account_id, device_id, relative_path)
);
CREATE TABLE IF NOT EXISTS backup_bindings (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  device_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  archived_at BIGINT,
  archive_key TEXT,
  created_at BIGINT NOT NULL,
  UNIQUE(account_id, device_id)
);
CREATE TABLE IF NOT EXISTS register_attempts (
  ip TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  start BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS guess_attempts (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  start BIGINT NOT NULL,
  last BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS oss_payments (
  account_id TEXT PRIMARY KEY,
  payment_intent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admin_accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS service_providers (
  id TEXT PRIMARY KEY,
  service TEXT NOT NULL,
  name TEXT NOT NULL,
  credentials_json TEXT NOT NULL DEFAULT '{}',
  settings_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE(service, name)
);
CREATE TABLE IF NOT EXISTS device_backup_buckets (
  device_id TEXT PRIMARY KEY,
  bucket_name TEXT NOT NULL UNIQUE,
  bucket_id TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  key_id TEXT NOT NULL,
  application_key_sealed TEXT NOT NULL,
  provisioned_at BIGINT NOT NULL,
  FOREIGN KEY(device_id) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS billing_storage_samples (
  account_id TEXT NOT NULL,
  period_ym TEXT NOT NULL,
  sampled_at BIGINT NOT NULL,
  stored_bytes BIGINT NOT NULL,
  PRIMARY KEY (account_id, sampled_at)
);
CREATE INDEX IF NOT EXISTS idx_billing_storage_period ON billing_storage_samples (account_id, period_ym);
CREATE TABLE IF NOT EXISTS billing_period_egress (
  account_id TEXT NOT NULL,
  period_ym TEXT NOT NULL,
  egress_bytes BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, period_ym)
);
`
