-- Application-level settings stored in the database.
-- These are loaded into the in-memory config struct on startup,
-- after the database connection is established.

CREATE TABLE IF NOT EXISTS app_settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    type  TEXT NOT NULL DEFAULT 'string',
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
