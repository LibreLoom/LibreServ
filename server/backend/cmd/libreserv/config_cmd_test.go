package main

import (
	"testing"
)

func TestValidateConfigValue(t *testing.T) {
	tests := []struct {
		name    string
		key     string
		value   string
		wantErr bool
	}{
		{"valid server.mode production", "server.mode", "production", false},
		{"valid server.mode development", "server.mode", "development", false},
		{"invalid server.mode", "server.mode", "staging", true},
		{"valid logging.level info", "logging.level", "info", false},
		{"valid logging.level debug", "logging.level", "debug", false},
		{"invalid logging.level", "logging.level", "verbose", true},
		{"valid caddy.mode enabled", "network.caddy.mode", "enabled", false},
		{"valid caddy.mode disabled", "network.caddy.mode", "disabled", false},
		{"valid caddy.mode noop", "network.caddy.mode", "noop", false},
		{"invalid caddy.mode", "network.caddy.mode", "auto", true},
		{"valid bool true", "notify.enabled", "true", false},
		{"valid bool false", "notify.enabled", "false", false},
		{"valid bool 1", "smtp.use_tls", "1", false},
		{"valid bool 0", "smtp.use_tls", "0", false},
		{"invalid bool", "notify.enabled", "maybe", true},
		{"valid int", "smtp.port", "587", false},
		{"valid int zero", "smtp.port", "0", false},
		{"invalid int", "smtp.port", "abc", true},
		{"string key any value", "smtp.host", "mail.example.com", false},
		{"string key empty value", "smtp.host", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			typ := dbBackedKeys[tt.key]
			err := validateConfigValue(tt.key, tt.value, typ)
			if (err != nil) != tt.wantErr {
				t.Errorf("validateConfigValue(%q, %q) error = %v, wantErr %v", tt.key, tt.value, err, tt.wantErr)
			}
		})
	}
}

func TestDbBackedKeysHaveTypes(t *testing.T) {
	for key, typ := range dbBackedKeys {
		if typ == "" {
			t.Errorf("dbBackedKeys[%q] has empty type", key)
		}
		validTypes := map[string]bool{"string": true, "int": true, "bool": true, "json": true}
		if !validTypes[typ] {
			t.Errorf("dbBackedKeys[%q] has unknown type %q", key, typ)
		}
	}
}

func TestValidEnumsSubsetOfDbBackedKeys(t *testing.T) {
	for key := range validEnums {
		if _, ok := dbBackedKeys[key]; !ok {
			t.Errorf("validEnums key %q not in dbBackedKeys", key)
		}
	}
}
