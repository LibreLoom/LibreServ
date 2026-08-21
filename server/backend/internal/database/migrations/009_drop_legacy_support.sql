-- Drop legacy support_sessions/support_audit tables never queried (audit dead code)
-- These were kept for transition but no Go code SELECTs/INSERTs them.
DROP TABLE IF EXISTS support_audit;
DROP TABLE IF EXISTS support_sessions;
DROP INDEX IF EXISTS idx_support_sessions_code_unique;
