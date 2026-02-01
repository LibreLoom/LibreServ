package config

import (
	"testing"

	"gopkg.in/yaml.v3"
)

// FuzzConfigUnmarshal fuzz tests configuration file parsing
// This tests YAML unmarshaling used by the config loader
func FuzzConfigUnmarshal(f *testing.F) {
	// Seed corpus with valid configurations
	f.Add([]byte(`
server:
  host: 0.0.0.0
  port: 8080
  mode: production
database:
  path: /data/libreserv.db
auth:
  jwt_secret: super-secret-key
apps:
  data_path: /data/apps
  catalog_path: /app/catalog
docker:
  method: socket
  socket_path: /var/run/docker.sock
logging:
  level: info
  path: /var/log/libreserv.log
network:
  caddy:
    mode: enabled
    admin_api: http://localhost:2019
    config_path: /etc/caddy/Caddyfile
    email: admin@example.com
    auto_https: true
`))
	f.Add([]byte(`
server:
  port: 3000
auth:
  secret_file: /etc/libreserv/secret
docker:
  method: tcp
  tcp:
    host: 192.168.1.100
    port: 2376
    use_tls: true
smtp:
  host: smtp.gmail.com
  port: 587
  username: user@gmail.com
  password: secret
  from: noreply@example.com
`))
	f.Add([]byte(`
# Minimal config
server:
  port: 8080
`))
	f.Add([]byte(`
# Edge cases
server:
  port: -1
  host: ""
auth:
  jwt_secret: ""
docker:
  method: ""
  timeout: -999
`))
	f.Add([]byte(`
# Special characters
server:
  host: "::1"
auth:
  jwt_secret: "secret-with-\\n-newlines-and-\"quotes\""
smtp:
  password: "p@$$w0rd!#$%^&*()"
`))
	f.Add([]byte(`
# Deeply nested
network:
  caddy:
    reload:
      retries: 10
      backoff_min: 500ms
      backoff_max: 30s
      attempt_timeout: 10s
      jitter_fraction: 0.2
    logging:
      output: file
      format: json
      level: debug
`))

	f.Fuzz(func(t *testing.T, data []byte) {
		var cfg Config

		// Test YAML unmarshaling - should not panic
		_ = yaml.Unmarshal(data, &cfg)

		// Access fields to ensure no panic on malformed input
		_ = cfg.Server.Port
		_ = cfg.Server.Host
		_ = cfg.Auth.JWTSecret
		_ = cfg.Docker.Method
		_ = cfg.Logging.Level
	})
}

// FuzzSMTPConfigUnmarshal fuzz tests SMTP configuration parsing
func FuzzSMTPConfigUnmarshal(f *testing.F) {
	f.Add([]byte(`
host: smtp.example.com
port: 587
username: user
password: pass
from: noreply@example.com
use_tls: true
skip_verify: false
`))
	f.Add([]byte(`
host: localhost
port: 25
`))
	f.Add([]byte(`
host: ""
port: 0
password: ""
`))

	f.Fuzz(func(t *testing.T, data []byte) {
		var smtp SMTPConfig
		_ = yaml.Unmarshal(data, &smtp)

		_ = smtp.Host
		_ = smtp.Port
		_ = smtp.Username
		_ = smtp.Password
	})
}

// FuzzDockerConfigUnmarshal fuzz tests Docker configuration parsing
func FuzzDockerConfigUnmarshal(f *testing.F) {
	f.Add([]byte(`
method: socket
socket_path: /var/run/docker.sock
timeout: 30s
`))
	f.Add([]byte(`
method: tcp
tcp:
  host: 192.168.1.100
  port: 2376
  use_tls: true
  cert_path: /certs/client.crt
`))
	f.Add([]byte(`
method: ssh
ssh:
  host: docker.example.com
  user: admin
  key_path: /home/admin/.ssh/id_rsa
`))
	f.Add([]byte(`
method: auto
`))

	f.Fuzz(func(t *testing.T, data []byte) {
		var docker DockerConfig
		_ = yaml.Unmarshal(data, &docker)

		_ = docker.Method
		_ = docker.SocketPath
		_ = docker.Timeout
		_ = docker.TCP.Host
		_ = docker.SSH.User
	})
}

// FuzzCaddyConfigUnmarshal fuzz tests Caddy configuration parsing
func FuzzCaddyConfigUnmarshal(f *testing.F) {
	f.Add([]byte(`
mode: enabled
admin_api: http://localhost:2019
config_path: /etc/caddy/Caddyfile
email: admin@example.com
auto_https: true
reload:
  retries: 5
  backoff_min: 200ms
  backoff_max: 5s
logging:
  output: stdout
  format: json
  level: info
`))
	f.Add([]byte(`
mode: disabled
`))
	f.Add([]byte(`
mode: noop
`))
	f.Add([]byte(`
mode: ""
admin_api: ""
config_path: ""
`))

	f.Fuzz(func(t *testing.T, data []byte) {
		var caddy CaddyConfig
		_ = yaml.Unmarshal(data, &caddy)

		_ = caddy.Mode
		_ = caddy.AdminAPI
		_ = caddy.ConfigPath
		_ = caddy.DefaultDomain
		_ = caddy.Reload.Retries
	})
}

// FuzzExternalACMEConfigUnmarshal fuzz tests ACME configuration parsing
func FuzzExternalACMEConfigUnmarshal(f *testing.F) {
	f.Add([]byte(`
enabled: true
use_docker: true
docker_image: goacme/lego:latest
data_path: /data/acme
dns_provider: cloudflare
email: admin@example.com
staging: false
`))
	f.Add([]byte(`
enabled: true
dns_provider: route53
dns_env:
  AWS_REGION: us-east-1
  AWS_ACCESS_KEY_ID: AKIA...
certs_path: /certs
`))
	f.Add([]byte(`
enabled: false
`))

	f.Fuzz(func(t *testing.T, data []byte) {
		var acme ExternalACMEConfig
		_ = yaml.Unmarshal(data, &acme)

		_ = acme.Enabled
		_ = acme.DNSProvider
		_ = acme.Email
		_ = acme.CertsPath

		// Test map access
		_ = acme.DNSEnv["TEST"]
	})
}
