-- Routes table (migrated from implicit creation in CaddyManager)
CREATE TABLE IF NOT EXISTS routes (
    id TEXT PRIMARY KEY,
    subdomain TEXT NOT NULL,
    domain TEXT NOT NULL,
    backend TEXT NOT NULL,
    app_id TEXT,
    ssl BOOLEAN DEFAULT TRUE,
    enabled BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(subdomain, domain)
);
