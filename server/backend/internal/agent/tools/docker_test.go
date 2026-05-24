package tools

import (
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

func TestRedactSensitiveFieldsEnv(t *testing.T) {
	input := map[string]interface{}{
		"Config": map[string]interface{}{
			"Env":    []string{"SECRET=abc123", "DB_PASSWORD=pass"},
			"Image":  "nginx:latest",
			"Labels": map[string]interface{}{},
		},
	}
	redactSensitiveFields(input)

	config := input["Config"].(map[string]interface{})
	env, ok := config["Env"].(string)
	if !ok {
		t.Fatal("Config.Env should be replaced with a string")
	}
	if env != "[REDACTED: contains secrets]" {
		t.Errorf("Config.Env = %q, want redacted", env)
	}
	if config["Image"] != "nginx:latest" {
		t.Error("Config.Image should not be redacted")
	}
}

func TestRedactSensitiveFieldsLabels(t *testing.T) {
	input := map[string]interface{}{
		"Config": map[string]interface{}{
			"Labels": map[string]interface{}{
				"com.example.name":    "myapp",
				"com.example.api-key": "sk-1234567890",
			},
		},
	}
	redactSensitiveFields(input)

	config := input["Config"].(map[string]interface{})
	labels := config["Labels"].(map[string]interface{})
	if labels["com.example.name"] != "myapp" {
		t.Error("non-secret label should not be redacted")
	}
	if labels["com.example.api-key"] != "••••••••" {
		t.Errorf("secret label = %q, want redacted", labels["com.example.api-key"])
	}
}

func TestRedactSensitiveFieldsBinds(t *testing.T) {
	input := map[string]interface{}{
		"HostConfig": map[string]interface{}{
			"Binds": []interface{}{"/host/path:/container/path", "/etc/secrets:/secrets"},
		},
	}
	redactSensitiveFields(input)

	hostConfig := input["HostConfig"].(map[string]interface{})
	binds, ok := hostConfig["Binds"].([]string)
	if !ok {
		t.Fatal("HostConfig.Binds should be []string")
	}
	for _, b := range binds {
		if b != "[REDACTED: may contain credentials in mount paths]" {
			t.Errorf("HostConfig.Binds not redacted: %q", b)
		}
	}
}

func TestRedactSensitiveFieldsNetworkSettings(t *testing.T) {
	input := map[string]interface{}{
		"NetworkSettings": map[string]interface{}{
			"Ports": map[string]interface{}{
				"80/tcp":  []interface{}{"0.0.0.0:8080"},
				"443/tcp": []interface{}{"0.0.0.0:8443"},
			},
		},
	}
	redactSensitiveFields(input)

	netSettings := input["NetworkSettings"].(map[string]interface{})
	ports := netSettings["Ports"].(map[string]interface{})
	for _, v := range ports {
		if v != "[REDACTED: contains host binding details]" {
			t.Errorf("port not redacted: %v", v)
		}
	}
}

func TestIsSecretKey(t *testing.T) {
	tests := []struct {
		key   string
		value string
		want  bool
	}{
		{"password", "abc", true},
		{"API_KEY", "sk-123", true},
		{"api-key", "key123", true},
		{"token", "tok", true},
		{"SECRET", "s", true},
		{"credential", "c", true},
		{"name", "myapp", false},
		{"version", "1.0", false},
		{"port", "8080", false},
		{"authorization", "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.rme3", true},
	}
	for _, tc := range tests {
		got := isSecretKey(tc.key, tc.value)
		if got != tc.want {
			t.Errorf("isSecretKey(%q, %q) = %v, want %v", tc.key, tc.value, got, tc.want)
		}
	}
}

func TestRedactSensitiveFieldsEmptyInput(t *testing.T) {
	input := map[string]interface{}{
		"Config": map[string]interface{}{
			"Image": "alpine",
		},
	}
	redactSensitiveFields(input)
	config := input["Config"].(map[string]interface{})
	if config["Image"] != "alpine" {
		t.Error("non-sensitive fields should not be modified")
	}
}

func TestRedactSensitiveFieldsNilMap(t *testing.T) {
	input := map[string]interface{}{
		"Id":   "abc123",
		"Name": "test-container",
	}
	redactSensitiveFields(input)
	if input["Id"] != "abc123" {
		t.Error("top-level non-sensitive fields should not be modified")
	}
}

func TestRegistryFromAgentDefWithNilDeps(t *testing.T) {
	def := config.AgentDefinition{
		ID:        "test-agent",
		ToolNames: []string{"docker", "diagnostics", "files"},
	}
	registry := RegistryFromAgentDef(def, ToolDeps{})

	_, hasDockerPS := registry.Get("docker_ps")
	if hasDockerPS {
		t.Error("docker_ps should not be in registry with nil docker client")
	}
	_, hasHealth := registry.Get("system_health")
	if !hasHealth {
		t.Error("expected system_health in registry (diagnostics work without docker)")
	}
	_, hasFileRead := registry.Get("file_read")
	if !hasFileRead {
		t.Error("expected file_read in registry (files work with default policy)")
	}
}

func TestRegistryFromAgentDefWithFiles(t *testing.T) {
	def := config.AgentDefinition{
		ID:        "test-agent",
		ToolNames: []string{"files"},
	}
	registry := RegistryFromAgentDef(def, ToolDeps{})

	_, hasFileRead := registry.Get("file_read")
	if !hasFileRead {
		t.Error("expected file_read in registry when files is in tool names")
	}
	_, hasFileWrite := registry.Get("file_write")
	if !hasFileWrite {
		t.Error("expected file_write in registry when files is in tool names")
	}
	_, hasDockerPS := registry.Get("docker_ps")
	if hasDockerPS {
		t.Error("docker_ps should NOT be in registry when docker is not in tool names")
	}
}

func TestRegistryFromAgentDefEmpty(t *testing.T) {
	def := config.AgentDefinition{
		ID:        "test-agent",
		ToolNames: []string{},
	}
	registry := RegistryFromAgentDef(def, ToolDeps{})

	if len(registry.All()) != 0 {
		t.Errorf("empty tool names should produce empty registry, got %d tools", len(registry.All()))
	}
}
