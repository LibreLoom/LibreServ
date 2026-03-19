package security

import (
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

func withConfig(cfg *config.Config, fn func()) {
	orig := config.Get()
	config.SetTestConfig(cfg)
	defer config.SetTestConfig(orig)
	fn()
}

func secureConfig() *config.Config {
	return &config.Config{
		Server: config.ServerConfig{
			Host: "127.0.0.1",
			Port: 8080,
			Mode: "production",
		},
		Auth: config.AuthConfig{
			JWTSecret:  "a8f4e2d1b6c9e3f7a0d5c8b2e6f9a3d7c1e5b9a4f8d2e6c0b7a3f9d5e1c8b4a6",
			CSRFSecret: "b7d3e1f9a5c8b2e6f0d4a7c3e9b5f1d8a2c6e0b4f7a3d9e5c1b8f4a6d2e7c3b0",
		},
		Docker: config.DockerConfig{
			Method: "socket",
		},
		Logging: config.LoggingConfig{
			Level: "info",
		},
		CORS: config.CORSConfig{
			AllowedOrigins: []string{"https://example.com"},
		},
	}
}

func TestValidateConfig_ProductionSecure(t *testing.T) {
	cfg := secureConfig()
	withConfig(cfg, func() {
		result := ValidateConfig()
		if !result.Passed {
			var msgs []string
			for _, issue := range result.Issues {
				msgs = append(msgs, issue.Severity+": "+issue.Category+": "+issue.Message)
			}
			t.Errorf("expected secure config to pass, got issues:\n%s", strings.Join(msgs, "\n"))
		}
		if result.IsDevMode {
			t.Error("expected IsDevMode=false")
		}
	})
}

func TestValidateConfig_DevModeFlags(t *testing.T) {
	cfg := secureConfig()
	cfg.Server.Mode = "development"
	withConfig(cfg, func() {
		result := ValidateConfig()
		if result.Passed {
			t.Error("dev mode should not pass")
		}
		if !result.IsDevMode {
			t.Error("expected IsDevMode=true")
		}

		var hasDevModeIssue bool
		for _, issue := range result.Issues {
			if issue.Category == "Mode" && issue.Severity == "HIGH" {
				hasDevModeIssue = true
			}
		}
		if !hasDevModeIssue {
			t.Error("expected dev mode security issue")
		}
	})
}

func TestValidateConfig_EmptyJWTSecret(t *testing.T) {
	cfg := secureConfig()
	cfg.Auth.JWTSecret = ""
	withConfig(cfg, func() {
		result := ValidateConfig()
		if result.Passed {
			t.Error("empty JWT secret should fail")
		}
		var found bool
		for _, issue := range result.Issues {
			if issue.Category == "Authentication" && strings.Contains(issue.Message, "JWT secret is not configured") {
				found = true
			}
		}
		if !found {
			t.Error("expected JWT secret issue")
		}
	})
}

func TestValidateConfig_EmptyCSRFSecret(t *testing.T) {
	cfg := secureConfig()
	cfg.Auth.CSRFSecret = ""
	withConfig(cfg, func() {
		result := ValidateConfig()
		if result.Passed {
			t.Error("empty CSRF secret should fail")
		}
		var found bool
		for _, issue := range result.Issues {
			if issue.Category == "CSRF" && strings.Contains(issue.Message, "CSRF secret is not configured") {
				found = true
			}
		}
		if !found {
			t.Error("expected CSRF secret issue")
		}
	})
}

func TestValidateConfig_ShortCSRFSecret(t *testing.T) {
	cfg := secureConfig()
	cfg.Auth.CSRFSecret = "short"
	withConfig(cfg, func() {
		result := ValidateConfig()
		if result.Passed {
			t.Error("short CSRF secret should fail")
		}
		var found bool
		for _, issue := range result.Issues {
			if issue.Category == "CSRF" && issue.Severity == "HIGH" && strings.Contains(issue.Message, "shorter than 32") {
				found = true
			}
		}
		if !found {
			t.Error("expected short CSRF secret issue")
		}
	})
}

func TestValidateConfig_HardcodedSecret(t *testing.T) {
	cfg := secureConfig()
	cfg.Auth.JWTSecret = "changeme_this_is_a_very_long_hardcoded_secret_value_for_testing"
	withConfig(cfg, func() {
		result := ValidateConfig()
		var found bool
		for _, issue := range result.Issues {
			if issue.Category == "Authentication" && strings.Contains(issue.Message, "hardcoded") {
				found = true
			}
		}
		if !found {
			t.Error("expected hardcoded JWT secret warning")
		}
	})
}

func TestValidateConfig_WildcardCORS(t *testing.T) {
	cfg := secureConfig()
	cfg.CORS.AllowedOrigins = []string{"*"}
	withConfig(cfg, func() {
		result := ValidateConfig()
		if result.Passed {
			t.Error("wildcard CORS should fail")
		}
		var found bool
		for _, issue := range result.Issues {
			if issue.Category == "CORS" && strings.Contains(issue.Message, "wildcard") {
				found = true
			}
		}
		if !found {
			t.Error("expected wildcard CORS issue")
		}
	})
}

func TestValidateConfig_EmptyCORS(t *testing.T) {
	cfg := secureConfig()
	cfg.CORS.AllowedOrigins = nil
	withConfig(cfg, func() {
		result := ValidateConfig()
		var found bool
		for _, issue := range result.Issues {
			if issue.Category == "CORS" && strings.Contains(issue.Message, "empty") {
				found = true
			}
		}
		if !found {
			t.Error("expected empty CORS warning")
		}
	})
}

func TestValidateConfig_DockerTCP(t *testing.T) {
	cfg := secureConfig()
	cfg.Docker.Method = "tcp"
	withConfig(cfg, func() {
		result := ValidateConfig()
		if result.Passed {
			t.Error("Docker TCP should fail")
		}
		var found bool
		for _, issue := range result.Issues {
			if issue.Category == "Docker" && strings.Contains(issue.Message, "TCP") {
				found = true
			}
		}
		if !found {
			t.Error("expected Docker TCP issue")
		}
	})
}

func TestValidateConfig_DebugLogging(t *testing.T) {
	cfg := secureConfig()
	cfg.Server.Mode = "development"
	cfg.Logging.Level = "debug"
	withConfig(cfg, func() {
		result := ValidateConfig()
		var found bool
		for _, issue := range result.Issues {
			if issue.Category == "Logging" && strings.Contains(issue.Message, "Debug logging") {
				found = true
			}
		}
		if !found {
			t.Error("expected debug logging warning in dev mode")
		}
	})
}

func TestValidateConfig_DevModeDevTokenImplicit(t *testing.T) {
	cfg := secureConfig()
	cfg.Server.Mode = "development"
	withConfig(cfg, func() {
		t.Setenv("LIBRESERV_DEV_TOKEN_ENABLED", "")
		result := ValidateConfig()
		var found bool
		for _, issue := range result.Issues {
			if issue.Category == "Dev Mode" && issue.Severity == "CRITICAL" {
				found = true
			}
		}
		if !found {
			t.Error("expected critical dev token issue")
		}
	})
}

func TestValidateConfig_DevModeDevTokenExplicit(t *testing.T) {
	cfg := secureConfig()
	cfg.Server.Mode = "development"
	withConfig(cfg, func() {
		t.Setenv("LIBRESERV_DEV_TOKEN_ENABLED", "true")
		result := ValidateConfig()
		var found bool
		for _, issue := range result.Issues {
			if issue.Category == "Dev Mode" && issue.Severity == "CRITICAL" {
				found = true
			}
		}
		if !found {
			t.Error("expected critical dev token issue when explicitly enabled")
		}
	})
}

func TestIsLoopback(t *testing.T) {
	tests := []struct {
		host string
		want bool
	}{
		{"localhost", true},
		{"127.0.0.1", true},
		{"::1", true},
		{"127.0.0.2", true},
		{"10.0.0.1", false},
		{"example.com", false},
		{"0.0.0.0", false},
		{"", false},
	}

	for _, tt := range tests {
		t.Run(tt.host, func(t *testing.T) {
			if got := IsLoopback(tt.host); got != tt.want {
				t.Errorf("IsLoopback(%q) = %v, want %v", tt.host, got, tt.want)
			}
		})
	}
}

func TestIsLikelyHardcoded(t *testing.T) {
	tests := []struct {
		secret string
		want   bool
	}{
		{"changeme_this_is_a_long_hardcoded_secret", true},
		{"password_with_enough_length_to_test", true},
		{"my-secret-key-for-jwt-signing-here", true},
		{"your-jwt-secret-value-here-pls-change", true},
		{"default-config-secret-change-me-please", true},
		{"A8f4e2d1b6c9e3f7a0d5c8b2e6f9a3d7c1e5b9a4f8", false}, // looks random
		{"short", false}, // too short to check
		{"", false},
	}

	for _, tt := range tests {
		t.Run(tt.secret, func(t *testing.T) {
			if got := isLikelyHardcoded(tt.secret); got != tt.want {
				t.Errorf("isLikelyHardcoded(%q) = %v, want %v", tt.secret, got, tt.want)
			}
		})
	}
}
