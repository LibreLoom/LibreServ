-- conversation_events stores the agent event stream for each conversation
-- so the UI can replay the deliberation trace after a page reload.
CREATE TABLE IF NOT EXISTS conversation_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    event_data TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES agent_conversations(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_conversation_events_conv ON conversation_events(conversation_id);
