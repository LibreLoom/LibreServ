package main

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func captureStdout(t *testing.T, fn func()) string {
	t.Helper()
	original := os.Stdout
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	os.Stdout = writer
	defer func() { os.Stdout = original }()

	fn()
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(reader)
	if err != nil {
		t.Fatal(err)
	}
	_ = reader.Close()
	return string(data)
}

func TestResolveConfigValueAllSections(t *testing.T) {
	cfg := &config.Config{
		Server:   config.ServerConfig{Host: "server.test", Port: 9090, Mode: "development"},
		Database: config.DatabaseConfig{Path: "/data/libreserv.db"},
		Apps:     config.AppsConfig{DataPath: "/data/apps", CatalogPath: "/catalog"},
		Runtime:  config.RuntimeConfig{Method: "socket", SocketPath: "/run/podman.sock"},
		Logging:  config.LoggingConfig{Level: "debug", Path: "/logs/libreserv.log"},
		SMTP: config.SMTPConfig{
			Host: "smtp.test", Port: 2525, Username: "mailer", Password: "secret",
			From: "LibreServ <server@example.test>", UseTLS: true, SkipVerify: true,
		},
		Notify: config.Notifications{
			Enabled: true, SupportRecipients: []string{"one@example.test", "two@example.test"},
			SupportSubject: "Support", SupportBody: "Help", WelcomeSubject: "Welcome", WelcomeBody: "Hello",
		},
		CORS: config.CORSConfig{AllowedOrigins: []string{"https://one.test", "https://two.test"}},
		Network: config.NetworkConfig{Caddy: config.CaddyConfig{
			Mode: "enabled", AdminAPI: "http://localhost:2019", ConfigPath: "/etc/Caddyfile",
			CertsPath: "/certs", DefaultDomain: "example.test", Email: "admin@example.test", AutoHTTPS: true,
		}},
		Auth: config.AuthConfig{JWTSecret: "jwt", CSRFSecret: "csrf"},
		Updates: config.UpdatesConfig{
			BaseURL: "https://forge.example.test/api/v1", Owner: "LibreLoom", Repo: "LibreServ",
		},
	}
	cases := map[string]string{
		"server.host":                  "server.test",
		"server.port":                  "9090",
		"server.mode":                  "development",
		"database.path":                "/data/libreserv.db",
		"apps.data_path":               "/data/apps",
		"apps.catalog_path":            "/catalog",
		"runtime.method":               "socket",
		"runtime.socket_path":          "/run/podman.sock",
		"logging.level":                "debug",
		"logging.path":                 "/logs/libreserv.log",
		"smtp.host":                    "smtp.test",
		"smtp.port":                    "2525",
		"smtp.username":                "mailer",
		"smtp.password":                "<redacted>",
		"smtp.from":                    "LibreServ <server@example.test>",
		"smtp.use_tls":                 "true",
		"smtp.skip_verify":             "true",
		"notify.enabled":               "true",
		"notify.support_recipients":    "one@example.test,two@example.test",
		"notify.support_subject":       "Support",
		"notify.support_body":          "Help",
		"notify.welcome_subject":       "Welcome",
		"notify.welcome_body":          "Hello",
		"cors.allowed_origins":         "https://one.test,https://two.test",
		"network.caddy.mode":           "enabled",
		"network.caddy.admin_api":      "http://localhost:2019",
		"network.caddy.config_path":    "/etc/Caddyfile",
		"network.caddy.certs_path":     "/certs",
		"network.caddy.default_domain": "example.test",
		"network.caddy.email":          "admin@example.test",
		"network.caddy.auto_https":     "true",
		"auth.jwt_secret":              "<redacted>",
		"auth.csrf_secret":             "<redacted>",
		"updates.base_url":             "https://forge.example.test/api/v1",
		"updates.owner":                "LibreLoom",
		"updates.repo":                 "LibreServ",
		"unknown.value":                "",
		"invalid":                      "",
	}
	for key, want := range cases {
		if got := resolveConfigValue(key, cfg); got != want {
			t.Errorf("resolveConfigValue(%q) = %q, want %q", key, got, want)
		}
	}
}

func TestConfigCommandsSetGetAndDefaults(t *testing.T) {
	root := t.TempDir()
	dbPath := filepath.Join(root, "libreserv.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}

	cfgPath := filepath.Join(root, "libreserv.yaml")
	cfgYAML := fmt.Sprintf("server:\n  host: config.example.test\n  port: 8088\ndatabase:\n  path: %q\n", dbPath)
	if err := os.WriteFile(cfgPath, []byte(cfgYAML), 0o600); err != nil {
		t.Fatal(err)
	}

	output := captureStdout(t, func() {
		handleConfigCommand([]string{"set", "logging.level", "debug"}, cfgPath)
	})
	if !strings.Contains(output, "Set logging.level = debug") || !strings.Contains(output, "next restart") {
		t.Fatalf("unexpected config set output: %q", output)
	}

	output = captureStdout(t, func() {
		handleConfigCommand([]string{"get", "logging.level"}, cfgPath)
	})
	if strings.TrimSpace(output) != "debug" {
		t.Fatalf("database-backed config get = %q", output)
	}

	output = captureStdout(t, func() {
		cmdConfigGet("server.host", cfgPath)
	})
	if strings.TrimSpace(output) != "config.example.test" {
		t.Fatalf("YAML config get = %q", output)
	}

	output = captureStdout(t, func() {
		handleConfigCommand([]string{"defaults"}, cfgPath)
	})
	if !strings.Contains(output, "server.host") || !strings.Contains(output, "database.path") {
		t.Fatalf("default output missing expected keys: %q", output)
	}

	output = captureStdout(t, func() {
		cmdConfigDefaults(cfgPath)
	})
	if !strings.Contains(output, "network.caddy.mode") {
		t.Fatalf("direct defaults output missing Caddy mode: %q", output)
	}
}

func TestEnsureSecretsCompleteAndGenerated(t *testing.T) {
	original := config.Get()
	t.Cleanup(func() { config.SetTestConfig(original) })

	complete := &config.Config{Auth: config.AuthConfig{
		JWTSecret: "jwt", CSRFSecret: "csrf", CloudEncryptionKey: "cloud",
		MFA: config.AuthMFAConfig{TOTPEncryptionKey: "totp"},
	}}
	config.SetTestConfig(complete)
	if err := ensureSecrets(""); err != nil {
		t.Fatalf("complete secrets returned error: %v", err)
	}

	config.SetTestConfig(&config.Config{})
	if err := ensureSecrets(""); err == nil {
		t.Fatal("missing secrets without a config path succeeded")
	}
	if err := ensureSecrets(t.TempDir()); err == nil {
		t.Fatal("missing secrets with directory config path succeeded")
	}

	cfgPath := filepath.Join(t.TempDir(), "libreserv.yaml")
	if err := os.WriteFile(cfgPath, []byte("{}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	generated := &config.Config{}
	config.SetTestConfig(generated)
	if err := ensureSecrets(cfgPath); err != nil {
		t.Fatalf("generate secrets: %v", err)
	}
	if len(generated.Auth.JWTSecret) < 32 ||
		len(generated.Auth.CSRFSecret) < 32 ||
		len(generated.Auth.CloudEncryptionKey) < 32 ||
		len(generated.Auth.MFA.TOTPEncryptionKey) < 32 {
		t.Fatalf("one or more secrets were not generated: %+v", generated.Auth)
	}
	saved, err := os.ReadFile(cfgPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"jwt_secret", "csrf_secret", "cloud_encryption_key", "totp_encryption_key"} {
		if !strings.Contains(string(saved), key) {
			t.Errorf("saved config missing %s: %s", key, saved)
		}
	}
}
