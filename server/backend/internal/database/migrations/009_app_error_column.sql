-- Add error column to apps table for storing install/update error messages
ALTER TABLE apps ADD COLUMN error TEXT;