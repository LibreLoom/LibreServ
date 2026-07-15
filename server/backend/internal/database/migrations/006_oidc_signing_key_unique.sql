-- Enforce at most one current OIDC signing key. A partial unique index (only
-- over rows where is_current = 1) prevents a race in RotateSigningKey from
-- leaving two keys current (or zero, handled in code). SQLite evaluates the
-- expression `is_current = 1` as 1/0, so the index covers only current rows.
-- NOTE: SQLite does not support IF NOT EXISTS for partial expression indexes
-- via CREATE INDEX IF NOT EXISTS on the same expression reliably across
-- versions; this runs idempotently because the index name is fixed.
DROP INDEX IF EXISTS idx_oidc_signing_keys_single_current;
CREATE UNIQUE INDEX idx_oidc_signing_keys_single_current
    ON oidc_signing_keys (is_current)
    WHERE is_current = 1;