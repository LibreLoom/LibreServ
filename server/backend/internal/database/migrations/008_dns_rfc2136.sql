-- Extend dns_provider_configs for the RFC 2136 provider (BYO DNS via dynamic
-- UPDATE): nameserver host:port, TSIG key name/secret, and HMAC algorithm.
ALTER TABLE dns_provider_configs ADD COLUMN nameserver TEXT NOT NULL DEFAULT '';
ALTER TABLE dns_provider_configs ADD COLUMN tsig_key_name TEXT NOT NULL DEFAULT '';
ALTER TABLE dns_provider_configs ADD COLUMN tsig_secret TEXT NOT NULL DEFAULT '';
ALTER TABLE dns_provider_configs ADD COLUMN hmac_algorithm TEXT NOT NULL DEFAULT 'hmac-sha256';