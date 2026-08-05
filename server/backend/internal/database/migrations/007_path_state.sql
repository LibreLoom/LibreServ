-- Network exposure path state: one row per app × path × protocol × port,
-- carrying the verify history and consecutive failure/success counters the
-- decision engine uses for hysteresis (no flapping between paths on
-- transient failures). Web paths use protocol '' and port 0.
CREATE TABLE IF NOT EXISTS path_state (
    id INTEGER PRIMARY KEY,
    app_id TEXT NOT NULL,
    path TEXT NOT NULL,                -- "direct_v4" | "direct_v6" | "upnp" | "cloudflared" | "frp" | "lan_only"
    protocol TEXT NOT NULL DEFAULT '', -- "tcp" | "udp" | "" (web path)
    port INTEGER NOT NULL DEFAULT 0,   -- 0 for web paths
    consecutive_failures INTEGER NOT NULL DEFAULT 0,
    consecutive_successes INTEGER NOT NULL DEFAULT 0,
    last_verified_at INTEGER,
    last_failure_at INTEGER,
    last_failure_reason TEXT,
    updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
    UNIQUE (app_id, path, protocol, port)
);

CREATE INDEX IF NOT EXISTS idx_path_state_app ON path_state (app_id);