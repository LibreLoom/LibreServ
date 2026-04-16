ALTER TABLE setup_state ADD COLUMN current_step TEXT NOT NULL DEFAULT 'checking';
ALTER TABLE setup_state ADD COLUMN current_sub_step TEXT;
ALTER TABLE setup_state ADD COLUMN step_data TEXT DEFAULT '{}';
ALTER TABLE setup_state ADD COLUMN progress_updated_at TIMESTAMP;
