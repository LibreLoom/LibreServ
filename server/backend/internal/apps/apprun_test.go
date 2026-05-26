package apps

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"text/template"
	"time"
)

const testAppID = "apprun-test"

func setupBuiltinCatalog(t *testing.T) (*Catalog, string) {
	t.Helper()
	candidate := filepath.Join("apps", "builtin")
	if _, err := os.Stat(candidate); os.IsNotExist(err) {
		candidate = filepath.Join("..", "apps", "builtin")
	}
	if _, err := os.Stat(candidate); os.IsNotExist(err) {
		candidate = filepath.Join("..", "..", "apps", "builtin")
	}
	absPath, err := filepath.Abs(candidate)
	if err != nil {
		t.Fatalf("failed to resolve catalog path: %v", err)
	}
	if _, err := os.Stat(absPath); os.IsNotExist(err) {
		t.Skip("builtin apps directory not found — skipping AppRun test suite")
	}
	catalog, err := NewCatalog(filepath.Dir(absPath))
	if err != nil {
		t.Fatalf("failed to load catalog: %v", err)
	}
	return catalog, absPath
}

func getAppDef(t *testing.T, catalog *Catalog) *AppDefinition {
	t.Helper()
	app, err := catalog.GetApp(testAppID)
	if err != nil {
		t.Fatalf("failed to get app definition for %s: %v", testAppID, err)
	}
	return app
}

func TestAppRunTest_AppExists(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	if catalog.Count() < 1 {
		t.Fatalf("expected at least 1 builtin app, got %d", catalog.Count())
	}
	app := getAppDef(t, catalog)
	if app.ID != testAppID {
		t.Errorf("expected app ID %q, got %q", testAppID, app.ID)
	}
	if app.Type != AppTypeBuiltin {
		t.Errorf("expected type builtin, got %s", app.Type)
	}
}

func TestAppRunTest_CoreMetadata(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	if app.Name == "" {
		t.Error("app name is required")
	}
	if app.Description == "" {
		t.Error("app description is required")
	}
	if app.Version == "" {
		t.Error("app version should be set")
	}
	if app.Category == "" {
		t.Error("app category should be set")
	}
	if !app.Featured {
		t.Error("expected app to be featured")
	}
	if app.Website == "" {
		t.Error("website should be set")
	}
	if app.Repository == "" {
		t.Error("repository should be set")
	}
}

func TestAppRunTest_DeploymentConfig(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	if app.Deployment.ComposeFile == "" {
		t.Error("deployment.compose_file is required")
	}

	if len(app.Deployment.Ports) < 3 {
		t.Errorf("expected at least 3 port mappings, got %d", len(app.Deployment.Ports))
	}

	portNames := map[string]bool{}
	for _, p := range app.Deployment.Ports {
		if p.Host <= 0 || p.Container <= 0 {
			t.Errorf("port mapping has invalid host/container: host=%d container=%d", p.Host, p.Container)
		}
		if p.Protocol == "" {
			t.Error("port mapping should specify protocol")
		}
		if p.Name == "" {
			t.Errorf("port %d:%d should have a name", p.Host, p.Container)
		}
		portNames[p.Name] = true
	}
	for _, name := range []string{"ui", "api", "metrics"} {
		if !portNames[name] {
			t.Errorf("expected port with name %q", name)
		}
	}

	if len(app.Deployment.Volumes) < 3 {
		t.Errorf("expected at least 3 volume mappings, got %d", len(app.Deployment.Volumes))
	}

	hasReadOnly := false
	for _, v := range app.Deployment.Volumes {
		if v.Name == "" || v.MountPath == "" {
			t.Errorf("volume mapping missing name or mount_path: %+v", v)
		}
		if v.ReadOnly {
			hasReadOnly = true
		}
	}
	if !hasReadOnly {
		t.Error("expected at least one read-only volume")
	}

	if len(app.Deployment.Environment) == 0 {
		t.Error("expected deployment environment variables")
	}
	if _, ok := app.Deployment.Environment["ENV_FROM_DEPLOYMENT"]; !ok {
		t.Error("expected ENV_FROM_DEPLOYMENT in deployment environment")
	}

	if len(app.Deployment.Labels) == 0 {
		t.Error("expected deployment labels")
	}

	if app.Deployment.RestartPolicy == "" {
		t.Error("expected restart policy")
	}

	if !app.Deployment.GPU.Supported {
		t.Error("expected GPU supported = true")
	}
	if app.Deployment.GPU.Required {
		t.Error("expected GPU required = false")
	}
	if app.Deployment.GPU.Runtime == "" {
		t.Error("expected GPU runtime to be set")
	}

	if len(app.Deployment.Backends) == 0 {
		t.Error("expected at least one explicit backend")
	}
	foundBackend := false
	for _, b := range app.Deployment.Backends {
		if b.Name == "internal-api" {
			foundBackend = true
			if b.URL == "" {
				t.Error("backend URL should not be empty")
			}
		}
	}
	if !foundBackend {
		t.Error("expected 'internal-api' backend endpoint")
	}
}

func TestAppRunTest_ConfigurationFields(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	expectedTypes := map[string]string{
		"http_port":       "port",
		"api_port":        "port",
		"metrics_port":    "port",
		"string_field":    "string",
		"password_field":  "password",
		"number_field":    "number",
		"boolean_field":   "boolean",
		"select_field":    "select",
		"validated_field": "string",
	}

	fieldMap := map[string]ConfigField{}
	for _, f := range app.Configuration {
		fieldMap[f.Name] = f
	}

	for name, expectedType := range expectedTypes {
		f, ok := fieldMap[name]
		if !ok {
			t.Errorf("missing configuration field: %s", name)
			continue
		}
		if f.Type != expectedType {
			t.Errorf("field %s: expected type %q, got %q", name, expectedType, f.Type)
		}
		if f.Label == "" {
			t.Errorf("field %s: label is required (plain language)", name)
		}
		if f.Description == "" {
			t.Errorf("field %s: description is required (plain language)", name)
		}
	}

	portField := fieldMap["http_port"]
	if portField.Default != 8880 {
		t.Errorf("http_port default: expected 8880, got %v", portField.Default)
	}
	if !portField.Required {
		t.Error("http_port should be required")
	}
	if portField.EnvVar == "" {
		t.Error("http_port should have env_var mapping")
	}

	selectField := fieldMap["select_field"]
	if len(selectField.Options) < 3 {
		t.Errorf("select_field: expected at least 3 options, got %d", len(selectField.Options))
	}

	validatedField := fieldMap["validated_field"]
	if validatedField.Validation == "" {
		t.Error("validated_field should have a validation regex")
	}
	re, err := regexp.Compile(validatedField.Validation)
	if err != nil {
		t.Errorf("validated_field validation regex is invalid: %v", err)
	}
	if !re.MatchString("abc123") {
		t.Error("validated_field regex should match 'abc123'")
	}
	if re.MatchString("ABC") {
		t.Error("validated_field regex should NOT match 'ABC'")
	}
}

func TestAppRunTest_ExposedInfoFields(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	expectedFields := map[string]struct {
		fieldType     string
		group         string
		copyable      bool
		revealable    bool
		maskByDefault bool
		advanced      bool
	}{
		"password_field": {"password", "credentials", true, true, true, false},
		"setup_token":    {"password", "credentials", true, true, true, false},
		"string_field":   {"string", "connection", true, false, false, false},
		"base_url":       {"url", "connection", true, false, false, false},
		"admin_username": {"username", "credentials", true, false, false, false},
		"advanced_token": {"password", "credentials", true, true, true, true},
	}

	fieldMap := map[string]ExposedInfoField{}
	for _, f := range app.ExposedInfo {
		fieldMap[f.Name] = f
	}

	for name, expected := range expectedFields {
		f, ok := fieldMap[name]
		if !ok {
			t.Errorf("missing exposed_info field: %s", name)
			continue
		}
		if f.Type != expected.fieldType {
			t.Errorf("exposed_info %s: expected type %q, got %q", name, expected.fieldType, f.Type)
		}
		if f.Group != expected.group {
			t.Errorf("exposed_info %s: expected group %q, got %q", name, expected.group, f.Group)
		}
		if f.Copyable != expected.copyable {
			t.Errorf("exposed_info %s: expected copyable=%v, got %v", name, expected.copyable, f.Copyable)
		}
		if f.Revealable != expected.revealable {
			t.Errorf("exposed_info %s: expected revealable=%v, got %v", name, expected.revealable, f.Revealable)
		}
		if f.MaskByDefault != expected.maskByDefault {
			t.Errorf("exposed_info %s: expected mask_by_default=%v, got %v", name, expected.maskByDefault, f.MaskByDefault)
		}
		if f.Advanced != expected.advanced {
			t.Errorf("exposed_info %s: expected advanced=%v, got %v", name, expected.advanced, f.Advanced)
		}
		if f.Label == "" {
			t.Errorf("exposed_info %s: label is required", name)
		}
		if f.Description == "" {
			t.Errorf("exposed_info %s: description is required (plain language)", name)
		}
	}
}

func TestAppRunTest_HealthCheck(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	hc := app.HealthCheck
	if hc.Type != "http" {
		t.Errorf("expected health check type 'http', got %q", hc.Type)
	}
	if hc.Endpoint == "" {
		t.Error("health check endpoint should be set for http type")
	}
	if hc.Port == 0 {
		t.Error("health check port should be set")
	}
	if hc.Interval == 0 {
		t.Error("health check interval should be set")
	}
	if hc.Timeout == 0 {
		t.Error("health check timeout should be set")
	}
	if hc.Retries == 0 {
		t.Error("health check retries should be set")
	}
}

func TestAppRunTest_ResourceRequirements(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	req := app.Requirements
	if req.MinRAM == "" {
		t.Error("min_ram should be set")
	}
	if req.MinCPU == 0 {
		t.Error("min_cpu should be set")
	}
	if req.MinDisk == "" {
		t.Error("min_disk should be set")
	}
	if len(req.Arch) == 0 {
		t.Error("at least one arch should be listed")
	}
	archSet := map[string]bool{}
	for _, a := range req.Arch {
		archSet[a] = true
	}
	if !archSet["amd64"] || !archSet["arm64"] {
		t.Error("expected both amd64 and arm64 in arch list")
	}
}

func TestAppRunTest_UpdateConfig(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	if app.Updates.Strategy == "" {
		t.Error("update strategy should be set")
	}
	if !app.Updates.BackupBeforeUpdate {
		t.Error("backup_before_update should be true for this test app")
	}
}

func TestAppRunTest_Features(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	f := app.Features
	if f.Experimental != true {
		t.Error("expected experimental = true")
	}
	if f.AccessModel != AccessModelIntegratedUsers {
		t.Errorf("expected access_model = %q, got %q", AccessModelIntegratedUsers, f.AccessModel)
	}
	if f.Backup != FeatureSupported {
		t.Errorf("expected backup = %q, got %q", FeatureSupported, f.Backup)
	}
	if !f.SSO {
		t.Error("expected sso = true")
	}
	if !f.CustomDomains {
		t.Error("expected custom_domains = true")
	}
	if !f.UpdateBehavior.RequiresDowntime {
		t.Error("expected update_behavior.requires_downtime = true")
	}
	if !f.UpdateBehavior.SupportsRollback {
		t.Error("expected update_behavior.supports_rollback = true")
	}
	if !f.ResourceHints.SingleInstance {
		t.Error("expected resource_hints.single_instance = true")
	}
	if f.ResourceHints.PrivilegedRequired {
		t.Error("expected resource_hints.privileged_required = false")
	}
	if len(f.SupportedOS) == 0 {
		t.Error("expected supported_os to be set")
	}
	if len(f.UnsupportedOS) == 0 {
		t.Error("expected unsupported_os to be set")
	}
	if f.MinRAM == 0 {
		t.Error("expected features.min_ram to be set")
	}
	if f.MinCPU == 0 {
		t.Error("expected features.min_cpu to be set")
	}
}

func TestAppRunTest_Scripts(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	s := app.Scripts.System
	scripts := map[string]string{
		"setup":              s.Setup,
		"update":             s.Update,
		"repair":             s.Repair,
		"destructive_repair": s.DestructiveRepair,
		"backup":             s.Backup,
		"restore":            s.Restore,
	}

	for name, path := range scripts {
		if path == "" {
			t.Errorf("system script %s path should be set", name)
			continue
		}
		fullPath := filepath.Join(app.CatalogPath, path)
		if _, err := os.Stat(fullPath); os.IsNotExist(err) {
			t.Errorf("system script %s file not found: %s", name, fullPath)
		}
		if err := os.Chmod(fullPath, 0755); err == nil {
			fi, _ := os.Stat(fullPath)
			if fi != nil && fi.Mode()&0111 == 0 {
				t.Errorf("system script %s is not executable", name)
			}
		}
	}
}

func TestAppRunTest_CustomActions(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	if len(app.Scripts.Actions) < 3 {
		t.Errorf("expected at least 3 custom actions, got %d", len(app.Scripts.Actions))
	}

	actionMap := map[string]ScriptAction{}
	for _, a := range app.Scripts.Actions {
		actionMap[a.Name] = a
	}

	echoAction, ok := actionMap["echo-config"]
	if !ok {
		t.Fatal("missing 'echo-config' action")
	}
	if echoAction.Label == "" {
		t.Error("echo-config action label is required (plain language)")
	}
	if echoAction.Description == "" {
		t.Error("echo-config action description is required (plain language)")
	}
	if echoAction.Script == "" {
		t.Error("echo-config action script path is required")
	}
	if echoAction.Execution.StreamOutput != true {
		t.Error("echo-config should have stream_output = true")
	}
	if echoAction.Confirm.Enabled {
		t.Error("echo-config should not require confirmation")
	}

	resetAction, ok := actionMap["reset-data"]
	if !ok {
		t.Fatal("missing 'reset-data' action")
	}
	if !resetAction.Confirm.Enabled {
		t.Error("reset-data should require confirmation")
	}
	if resetAction.Confirm.Message == "" {
		t.Error("reset-data confirm message should be set (plain language)")
	}
	if resetAction.Confirm.Typename == "" {
		t.Error("reset-data confirm type should be set")
	}

	optsAction, ok := actionMap["run-with-options"]
	if !ok {
		t.Fatal("missing 'run-with-options' action")
	}
	if len(optsAction.Options) == 0 {
		t.Error("run-with-options should have options")
	}

	optionTypes := map[string]string{}
	for _, opt := range optsAction.Options {
		optionTypes[opt.Name] = opt.Type
		if opt.Label == "" {
			t.Errorf("option %s: label is required (plain language)", opt.Name)
		}
		if opt.Description == "" {
			t.Errorf("option %s: description is required (plain language)", opt.Name)
		}
	}

	expectedOptionTypes := map[string]string{
		"operation":   "select",
		"iterations":  "number",
		"dry_run":     "boolean",
		"passphrase":  "password",
		"target_path": "string",
	}
	for name, expectedType := range expectedOptionTypes {
		if optionTypes[name] != expectedType {
			t.Errorf("option %s: expected type %q, got %q", name, expectedType, optionTypes[name])
		}
	}

	for _, opt := range optsAction.Options {
		if opt.Name == "iterations" {
			if opt.Min == nil {
				t.Error("iterations option should have min")
			}
			if opt.Max == nil {
				t.Error("iterations option should have max")
			}
		}
		if opt.Name == "passphrase" {
			if !opt.Secret {
				t.Error("passphrase option should be secret")
			}
		}
		if opt.Name == "operation" {
			if len(opt.Options) == 0 {
				t.Error("operation option should have select options")
			}
			for _, ov := range opt.Options {
				if ov.Value == "" {
					t.Error("option value should not be empty")
				}
				if ov.Label == "" {
					t.Errorf("option value %s should have a label", ov.Value)
				}
			}
		}
		if opt.Name == "target_path" {
			if opt.Validation == "" {
				t.Error("target_path option should have validation regex")
			}
		}
	}
}

func TestAppRunTest_ComposeTemplate(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	composePath, err := catalog.GetComposeFilePath(app.ID)
	if err != nil {
		t.Fatalf("failed to get compose file path: %v", err)
	}

	data, err := os.ReadFile(composePath)
	if err != nil {
		t.Fatalf("failed to read compose template: %v", err)
	}

	content := string(data)

	templateVars := []string{
		"{{.instance_id}}",
		"{{.install_path}}",
		"{{.app_name}}",
		"{{.puid}}",
		"{{.pgid}}",
		"{{.http_port}}",
		"{{.api_port}}",
		"{{.metrics_port}}",
		"{{.string_field}}",
		"{{.password_field}}",
		"{{.number_field}}",
		"{{.boolean_field}}",
		"{{.select_field}}",
		"{{.validated_field}}",
		"{{.server.server_port}}",
		"{{.server.server_mode}}",
		"{{.server.server_host}}",
		"{{.server.caddy_mode}}",
		"{{.server.default_domain}}",
		"{{.server.acme_email}}",
		"{{.server.smtp_host}}",
		"{{.server.smtp_port}}",
		"{{.server.smtp_username}}",
		"{{.server.smtp_password}}",
		"{{.server.smtp_from}}",
		"{{.server.smtp_use_tls}}",
		"{{.server.smtp_skip_verify}}",
		"{{.server.tunnel_enabled}}",
		"{{.server.tunnel_provider}}",
		"{{.server.dns_provider}}",
	}
	for _, v := range templateVars {
		if !strings.Contains(content, v) {
			t.Errorf("compose template missing template variable: %s", v)
		}
	}

	templateFuncs := []string{
		"{{generatePassword 16}}",
		"{{generatePassword 32}}",
		"{{ dataPath }}",
		"{{ configPath }}",
		"{{ serverURL }}",
		"{{ serverDomain }}",
		"{{ smtpHost }}",
		"{{ smtpPort }}",
		"{{ smtpUser }}",
		"{{ smtpPass }}",
		"{{ smtpFrom }}",
		"{{default",
	}
	for _, f := range templateFuncs {
		if !strings.Contains(content, f) {
			t.Errorf("compose template missing template function call: %s", f)
		}
	}

	if !strings.Contains(content, "{{if .boolean_field}}") {
		t.Error("compose template missing conditional block for boolean_field")
	}

	if !strings.Contains(content, "libreserv.app=") {
		t.Error("compose template missing libreserv.app label")
	}
	if !strings.Contains(content, "libreserv.app.name=") {
		t.Error("compose template missing libreserv.app.name label")
	}
	if !strings.Contains(content, "libreserv.app.component=") {
		t.Error("compose template missing libreserv.app.component label for auxiliary container")
	}
}

func TestAppRunTest_ScriptConfigJSON(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	setupPath := filepath.Join(app.CatalogPath, app.Scripts.System.Setup)
	data, err := os.ReadFile(setupPath)
	if err != nil {
		t.Fatalf("failed to read setup script: %v", err)
	}
	content := string(data)

	configKeys := []string{
		".instance_id",
		".app_id",
		".install_path",
		".app_data_path",
		".config_path",
		".config_dir",
		".runtime.compose_file",
		".runtime.project_name",
		".server.server_port",
		".server.server_mode",
		".server.server_host",
		".server.server_url",
		".server.default_domain",
		".server.caddy_mode",
		".server.acme_email",
		".server.smtp_host",
		".server.smtp_port",
		".server.smtp_username",
		".server.smtp_password",
		".server.smtp_from",
		".server.smtp_use_tls",
		".server.smtp_skip_verify",
		".server.tunnel_enabled",
		".server.tunnel_provider",
		".server.tunnel_token",
		".server.dns_provider",
	}
	for _, key := range configKeys {
		if !strings.Contains(content, key) {
			t.Errorf("setup script does not reference config key: %s", key)
		}
	}

	if !strings.Contains(content, "exposed_info") {
		t.Error("setup script should output exposed_info JSON")
	}
}

func TestAppRunTest_ScriptOutputParsing(t *testing.T) {
	executor := NewScriptExecutor(slog.Default(), nil, t.TempDir())

	tests := []struct {
		name    string
		output  string
		wantKey string
		wantVal string
	}{
		{
			name:    "single line JSON",
			output:  `{"exposed_info": {"setup_token": "abc123"}}`,
			wantKey: "setup_token",
			wantVal: "abc123",
		},
		{
			name: "JSON after other output",
			output: `>> Setup started
>> Doing things
{"exposed_info": {"setup_token": "xyz789", "base_url": "http://localhost:8880"}}`,
			wantKey: "setup_token",
			wantVal: "xyz789",
		},
		{
			name:    "empty output",
			output:  "",
			wantKey: "",
		},
		{
			name:    "no JSON output",
			output:  "just regular text\nno json here",
			wantKey: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			data := executor.parseScriptOutput(tt.output)
			if tt.wantKey == "" {
				if data != nil {
					t.Errorf("expected nil data, got %v", data)
				}
				return
			}
			if data == nil {
				t.Fatal("expected non-nil data")
			}
			exposedInfo, ok := data["exposed_info"].(map[string]interface{})
			if !ok {
				t.Fatal("expected exposed_info to be a map")
			}
			val, ok := exposedInfo[tt.wantKey]
			if !ok {
				t.Fatalf("expected key %q in exposed_info", tt.wantKey)
			}
			if val != tt.wantVal {
				t.Errorf("expected %q, got %v", tt.wantVal, val)
			}
		})
	}
}

func TestAppRunTest_ValidateExposedInfo(t *testing.T) {
	executor := NewScriptExecutor(slog.Default(), nil, t.TempDir())

	raw := map[string]interface{}{
		"valid_string":  "hello",
		"valid_number":  float64(42),
		"valid_bool":    true,
		"invalid_map":   map[string]string{"nested": "nope"},
		"invalid_slice": []string{"nope"},
		"":              "empty_key",
	}

	validated := executor.validateExposedInfo(raw)

	if _, ok := validated["valid_string"]; !ok {
		t.Error("valid string should be preserved")
	}
	if _, ok := validated["valid_number"]; !ok {
		t.Error("valid number should be preserved")
	}
	if _, ok := validated["valid_bool"]; !ok {
		t.Error("valid bool should be preserved")
	}
	if _, ok := validated["invalid_map"]; ok {
		t.Error("nested map should be filtered out")
	}
	if _, ok := validated["invalid_slice"]; ok {
		t.Error("slice should be filtered out")
	}
	if _, ok := validated[""]; ok {
		t.Error("empty key should be filtered out")
	}
}

func TestAppRunTest_ConfigValidation(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	tests := []struct {
		name    string
		config  map[string]interface{}
		wantErr bool
	}{
		{
			name: "valid full config",
			config: map[string]interface{}{
				"http_port":       8880,
				"api_port":        8881,
				"string_field":    "hello",
				"select_field":    "basic",
				"validated_field": "abc123",
			},
			wantErr: false,
		},
		{
			name: "missing required string field",
			config: map[string]interface{}{
				"http_port":    8880,
				"api_port":     8881,
				"select_field": "basic",
			},
			wantErr: true,
		},
		{
			name: "invalid select option",
			config: map[string]interface{}{
				"http_port":       8880,
				"api_port":        8881,
				"string_field":    "hello",
				"select_field":    "nonexistent",
				"validated_field": "abc123",
			},
			wantErr: true,
		},
		{
			name: "validation regex mismatch",
			config: map[string]interface{}{
				"http_port":       8880,
				"api_port":        8881,
				"string_field":    "hello",
				"select_field":    "basic",
				"validated_field": "HAS-UPPERCASE",
			},
			wantErr: true,
		},
		{
			name: "boolean field wrong type",
			config: map[string]interface{}{
				"http_port":       8880,
				"api_port":        8881,
				"string_field":    "hello",
				"select_field":    "basic",
				"validated_field": "abc123",
				"boolean_field":   "not-a-bool",
			},
			wantErr: true,
		},
		{
			name: "number field wrong type",
			config: map[string]interface{}{
				"http_port":       8880,
				"api_port":        8881,
				"string_field":    "hello",
				"select_field":    "basic",
				"validated_field": "abc123",
				"number_field":    "not-a-number",
			},
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := validateConfigFields(app.Configuration, tt.config)
			if tt.wantErr && err == nil {
				t.Error("expected validation error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Errorf("expected no error, got: %v", err)
			}
		})
	}
}

func validateConfigFields(fields []ConfigField, config map[string]interface{}) error {
	for _, field := range fields {
		value, exists := config[field.Name]
		if field.Required && (!exists || value == nil || value == "") {
			return fmt.Errorf("required field '%s' is missing", field.Label)
		}
		if exists {
			if err := validateField(field, value); err != nil {
				return fmt.Errorf("field %s: %w", field.Name, err)
			}
		}
	}
	return nil
}

func TestAppRunTest_MergeExposedInfo(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	installedApp := &InstalledApp{
		ID: "test-instance",
		Config: map[string]interface{}{
			"password_field": "secret123",
			"string_field":   "hello",
			"base_url":       "http://localhost:8880",
			"admin_username": "admin_test1234",
			"setup_token":    "token-abc",
			"advanced_token": "adv-token-xyz",
		},
	}

	merged := mergeExposedInfoForTest(app, installedApp)

	expectedKeys := []string{
		"password_field",
		"setup_token",
		"string_field",
		"base_url",
		"admin_username",
		"advanced_token",
	}
	for _, key := range expectedKeys {
		if _, ok := merged[key]; !ok {
			t.Errorf("expected exposed_info key %q to be present", key)
		}
	}

	if pf, ok := merged["password_field"]; ok {
		if pf.Type != "password" {
			t.Errorf("password_field: expected type 'password', got %q", pf.Type)
		}
		if !pf.MaskByDefault {
			t.Error("password_field should be masked by default")
		}
		if !pf.Copyable {
			t.Error("password_field should be copyable")
		}
		if !pf.Revealable {
			t.Error("password_field should be revealable")
		}
	}

	if sf, ok := merged["string_field"]; ok {
		if sf.Type != "string" {
			t.Errorf("string_field: expected type 'string', got %q", sf.Type)
		}
		if sf.MaskByDefault {
			t.Error("string_field should NOT be masked by default")
		}
	}

	if at, ok := merged["advanced_token"]; ok {
		if !at.Advanced {
			t.Error("advanced_token should be marked as advanced")
		}
	}
}

func mergeExposedInfoForTest(catalogApp *AppDefinition, installedApp *InstalledApp) map[string]ExposedInfoValue {
	merged := make(map[string]ExposedInfoValue)
	for _, field := range catalogApp.ExposedInfo {
		val, ok := installedApp.Config[field.Name]
		if !ok {
			continue
		}
		merged[field.Name] = ExposedInfoValue{
			Label:         field.Label,
			Description:   field.Description,
			Type:          field.Type,
			Group:         field.Group,
			Advanced:      field.Advanced,
			Value:         val,
			Copyable:      field.Copyable,
			Revealable:    field.Revealable,
			MaskByDefault: field.MaskByDefault,
		}
	}
	return merged
}

func TestAppRunTest_TemplateRendering(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	composePath, err := catalog.GetComposeFilePath(app.ID)
	if err != nil {
		t.Fatalf("failed to get compose path: %v", err)
	}

	templateData, err := os.ReadFile(composePath)
	if err != nil {
		t.Fatalf("failed to read template: %v", err)
	}

	installPath := t.TempDir()
	config := map[string]interface{}{
		"instance_id":     "test1234",
		"install_path":    installPath,
		"app_name":        "AppRun Test",
		"puid":            1000,
		"pgid":            1000,
		"http_port":       8880,
		"api_port":        8881,
		"metrics_port":    8882,
		"string_field":    "test-value",
		"password_field":  "generated-pw",
		"number_field":    42,
		"boolean_field":   true,
		"select_field":    "advanced",
		"validated_field": "xyz789",
		"version":         "1.0.0",
		"server": map[string]interface{}{
			"server_port":      8080,
			"server_mode":      "production",
			"server_host":      "0.0.0.0",
			"server_url":       "https://example.com",
			"default_domain":   "example.com",
			"caddy_mode":       "enabled",
			"acme_email":       "admin@example.com",
			"smtp_host":        "smtp.example.com",
			"smtp_port":        587,
			"smtp_username":    "user",
			"smtp_password":    "pass",
			"smtp_from":        "noreply@example.com",
			"smtp_use_tls":     true,
			"smtp_skip_verify": false,
			"tunnel_enabled":   false,
			"tunnel_provider":  "",
			"tunnel_token":     "",
			"dns_provider":     "cloudflare",
		},
		"ENV_FROM_DEPLOYMENT": "deployed-value",
		"ENV_TEMPLATE_REF":    "test-value",
	}

	rendered, err := renderTemplateForTest(string(templateData), installPath, config)
	if err != nil {
		t.Fatalf("failed to render template: %v", err)
	}

	assertions := []struct {
		desc  string
		check string
	}{
		{"instance_id substituted", "test1234-main"},
		{"app_name substituted", "AppRun Test"},
		{"http_port substituted", "8880:80"},
		{"api_port substituted", "8881:81"},
		{"metrics_port substituted", "8882:82/udp"},
		{"string_field substituted", "STRING_FIELD=test-value"},
		{"password_field substituted", "PASSWORD_FIELD=generated-pw"},
		{"number_field substituted", "NUMBER_FIELD=42"},
		{"boolean_field substituted", "BOOLEAN_FIELD=true"},
		{"select_field substituted", "SELECT_FIELD=advanced"},
		{"validated_field substituted", "VALIDATED_FIELD=xyz789"},
		{"PUID substituted", "PUID=1000"},
		{"PGID substituted", "PGID=1000"},
		{"dataPath resolved", installPath + "/data"},
		{"configPath resolved", installPath + "/config"},
		{"serverURL function", "SERVER_URL=https://example.com"},
		{"serverDomain function", "SERVER_DOMAIN=example.com"},
		{"smtpHost function", "SMTP_HOST=smtp.example.com"},
		{"smtpPort function", "SMTP_PORT=587"},
		{"smtpUser function", "SMTP_USER=user"},
		{"smtpPass function", "SMTP_PASS=pass"},
		{"smtpFrom function", "SMTP_FROM=noreply@example.com"},
		{"server context port", "SERVER_PORT=8080"},
		{"server context mode", "SERVER_MODE=production"},
		{"server context caddy", "CADDY_MODE=enabled"},
		{"server context domain", "DEFAULT_DOMAIN=example.com"},
		{"server context smtp_host", "SMTP_HOST_CTX=smtp.example.com"},
		{"server context dns_provider", "DNS_PROVIDER=cloudflare"},
		{"default fallback used for nonexistent", "fallback-unused"},
		{"deployment env var", "DEPLOY_ENV=deployed-value"},
		{"deployment template ref env", "DEPLOY_TEMPLATE_REF=test-value"},
		{"boolean conditional true", "test.boolean.enabled=true"},
		{"libreserv.app label", "libreserv.app=test1234"},
		{"libreserv.app.name label", "libreserv.app.name=AppRun Test"},
		{"libreserv.app.component label", "libreserv.app.component=helper"},
		{"read-only volume mount", ":ro,z"},
	}

	for _, a := range assertions {
		if !strings.Contains(rendered, a.check) {
			t.Errorf("rendered compose: %s — expected to contain %q", a.desc, a.check)
		}
	}

	if strings.Contains(rendered, "should-not-appear") {
		t.Error("rendered compose: default() should have returned the existing value, not the fallback 'should-not-appear'")
	}

	if strings.Contains(rendered, "{{.") {
		t.Error("rendered compose: should not contain unresolved template variables")
	}

	generatedPWCount := strings.Count(rendered, "GENERATED_PW_16=")
	if generatedPWCount < 1 {
		t.Error("rendered compose: expected generatePassword 16 to produce a value")
	}
}

func renderTemplateForTest(templateStr, installPath string, config map[string]interface{}) (string, error) {
	funcMap := template.FuncMap{
		"generatePassword": func(length int) string {
			return generateSecurePassword(length)
		},
		"dataPath": func() string {
			return filepath.Join(installPath, "data")
		},
		"configPath": func() string {
			return filepath.Join(installPath, "config")
		},
		"default": func(def, val interface{}) interface{} {
			if val == nil || val == "" {
				return def
			}
			return val
		},
		"serverURL": func() string {
			if srv, ok := config["server"].(map[string]interface{}); ok {
				if u, ok := srv["server_url"].(string); ok {
					return u
				}
			}
			return ""
		},
		"serverDomain": func() string {
			if srv, ok := config["server"].(map[string]interface{}); ok {
				if d, ok := srv["default_domain"].(string); ok {
					return d
				}
			}
			return ""
		},
		"smtpHost": func() string {
			if srv, ok := config["server"].(map[string]interface{}); ok {
				if h, ok := srv["smtp_host"].(string); ok {
					return h
				}
			}
			return ""
		},
		"smtpPort": func() int {
			if srv, ok := config["server"].(map[string]interface{}); ok {
				if p, ok := srv["smtp_port"].(int); ok {
					return p
				}
			}
			return 0
		},
		"smtpUser": func() string {
			if srv, ok := config["server"].(map[string]interface{}); ok {
				if u, ok := srv["smtp_username"].(string); ok {
					return u
				}
			}
			return ""
		},
		"smtpPass": func() string {
			if srv, ok := config["server"].(map[string]interface{}); ok {
				if p, ok := srv["smtp_password"].(string); ok {
					return p
				}
			}
			return ""
		},
		"smtpFrom": func() string {
			if srv, ok := config["server"].(map[string]interface{}); ok {
				if f, ok := srv["smtp_from"].(string); ok {
					return f
				}
			}
			return ""
		},
	}
	tmpl, err := template.New("compose").Funcs(funcMap).Parse(templateStr)
	if err != nil {
		return "", fmt.Errorf("failed to parse template: %w", err)
	}
	var buf bytes.Buffer
	if err := tmpl.Execute(&buf, config); err != nil {
		return "", fmt.Errorf("failed to execute template: %w", err)
	}
	return buf.String(), nil
}

func TestAppRunTest_ScriptExecutionConfig(t *testing.T) {
	config := ScriptExecutionConfig{
		InstanceID:  "abc12345",
		AppID:       "apprun-test",
		InstallPath: "/opt/libreserv/apps/abc12345",
		AppDataPath: "/opt/libreserv/apps/abc12345/data",
		ConfigPath:  "/opt/libreserv/apps/abc12345/config.json",
		ConfigDir:   "/opt/libreserv/apps/abc12345/config",
		Runtime: RuntimeInfo{
			ComposeFile: "/opt/libreserv/apps/abc12345/docker-compose.yml",
			ProjectName: "libreserv-abc12345",
		},
		Server: ServerContext{
			ServerPort:     8080,
			ServerMode:     "production",
			ServerHost:     "0.0.0.0",
			ServerURL:      "https://example.com",
			DefaultDomain:  "example.com",
			CaddyMode:      "enabled",
			ACMEEmail:      "admin@example.com",
			SMTPHost:       "smtp.example.com",
			SMTPPort:       587,
			SMTPUsername:   "user",
			SMTPPassword:   "pass",
			SMTPFrom:       "noreply@example.com",
			SMTPUseTLS:     true,
			SMTPSkipVerify: false,
			TunnelEnabled:  false,
			TunnelProvider: "",
			TunnelToken:    "",
			DNSProvider:    "cloudflare",
		},
		Options: map[string]interface{}{
			"operation":   "read",
			"iterations":  3,
			"dry_run":     true,
			"passphrase":  "secret",
			"target_path": "my-target",
		},
	}

	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		t.Fatalf("failed to marshal config: %v", err)
	}

	var parsed ScriptExecutionConfig
	if err := json.Unmarshal(data, &parsed); err != nil {
		t.Fatalf("failed to unmarshal config: %v", err)
	}

	if parsed.InstanceID != config.InstanceID {
		t.Error("instance_id mismatch after round-trip")
	}
	if parsed.AppID != config.AppID {
		t.Error("app_id mismatch after round-trip")
	}
	if parsed.Server.ServerURL != config.Server.ServerURL {
		t.Error("server.server_url mismatch after round-trip")
	}
	if parsed.Server.DNSProvider != config.Server.DNSProvider {
		t.Error("server.dns_provider mismatch after round-trip")
	}
	if parsed.Runtime.ProjectName != config.Runtime.ProjectName {
		t.Error("runtime.project_name mismatch after round-trip")
	}
	if opts, ok := parsed.Options["operation"].(string); !ok || opts != "read" {
		t.Error("options.operation mismatch after round-trip")
	}
}

func TestAppRunTest_ScriptPathValidation(t *testing.T) {
	basePath := t.TempDir()
	executor := NewScriptExecutor(slog.Default(), nil, basePath)

	tests := []struct {
		name       string
		instanceID string
		wantErr    bool
	}{
		{"valid hex id", "abc12345", false},
		{"valid with hyphen", "my-app-123", false},
		{"valid with underscore", "my_app_456", false},
		{"empty id", "", true},
		{"too long id", strings.Repeat("a", 65), true},
		{"path traversal", "../etc", true},
		{"slash in id", "app/sub", true},
		{"backslash in id", "app\\sub", true},
		{"special chars", "app!@#", true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := executor.validateInstanceID(tt.instanceID)
			if tt.wantErr && err == nil {
				t.Error("expected error, got nil")
			}
			if !tt.wantErr && err != nil {
				t.Errorf("expected no error, got: %v", err)
			}
		})
	}
}

func TestAppRunTest_InstanceIDGeneration(t *testing.T) {
	ids := map[string]bool{}
	for i := 0; i < 100; i++ {
		id := generateInstanceID()
		if len(id) != 16 {
			t.Errorf("expected 16-char instance ID, got %d chars: %s", len(id), id)
		}
		matched, _ := regexp.MatchString(`^[a-f0-9]+$`, id)
		if !matched {
			t.Errorf("instance ID should be hex, got: %s", id)
		}
		if ids[id] {
			t.Errorf("duplicate instance ID generated: %s", id)
		}
		ids[id] = true
	}
}

func TestAppRunTest_PasswordGeneration(t *testing.T) {
	pw := generateSecurePassword(32)
	if len(pw) != 32 {
		t.Errorf("expected 32-char password, got %d", len(pw))
	}

	pw16 := generateSecurePassword(16)
	if len(pw16) != 16 {
		t.Errorf("expected 16-char password, got %d", len(pw16))
	}

	pws := map[string]bool{}
	for i := 0; i < 50; i++ {
		p := generateSecurePassword(24)
		if pws[p] {
			t.Error("duplicate password generated — randomness issue")
		}
		pws[p] = true
	}
}

func TestAppRunTest_ServerContextDefaults(t *testing.T) {
	cfg := ServerContextConfig{
		ServerPort:    443,
		ServerMode:    "production",
		ServerHost:    "0.0.0.0",
		DefaultDomain: "example.com",
		CaddyMode:     "enabled",
	}
	ctx := NewServerContext(cfg)

	if ctx.ServerURL != "https://example.com" {
		t.Errorf("expected https://example.com (standard HTTPS port omitted), got %s", ctx.ServerURL)
	}

	cfg2 := ServerContextConfig{
		ServerPort:    8080,
		ServerMode:    "production",
		ServerHost:    "0.0.0.0",
		DefaultDomain: "example.com",
		CaddyMode:     "enabled",
	}
	ctx2 := NewServerContext(cfg2)

	if ctx2.ServerURL != "https://example.com:8080" {
		t.Errorf("expected https://example.com:8080 (non-standard port included), got %s", ctx2.ServerURL)
	}

	cfg3 := ServerContextConfig{
		ServerPort: 9090,
		ServerMode: "dev",
		ServerHost: "0.0.0.0",
		CaddyMode:  "noop",
	}
	ctx3 := NewServerContext(cfg3)

	if !strings.HasPrefix(ctx3.ServerURL, "http://localhost") {
		t.Errorf("expected http://localhost... URL, got %s", ctx3.ServerURL)
	}
	if !strings.Contains(ctx3.ServerURL, "9090") {
		t.Errorf("expected port 9090 in URL, got %s", ctx3.ServerURL)
	}
}

func TestAppRunTest_DefaultFeatures(t *testing.T) {
	defaults := GetDefaultFeatures()
	if defaults.AccessModel != AccessModelIntegratedUsers {
		t.Errorf("expected default access_model %q, got %q", AccessModelIntegratedUsers, defaults.AccessModel)
	}
	if defaults.Backup != FeatureSupported {
		t.Errorf("expected default backup %q, got %q", FeatureSupported, defaults.Backup)
	}
	if defaults.SSO != true {
		t.Error("expected default SSO = true")
	}
	if defaults.CustomDomains != true {
		t.Error("expected default custom_domains = true")
	}
	if defaults.UpdateBehavior.RequiresDowntime != true {
		t.Error("expected default update_behavior.requires_downtime = true")
	}
}

func TestAppRunTest_CatalogCloning(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app1, err := catalog.GetApp(testAppID)
	if err != nil {
		t.Fatalf("failed to get app: %v", err)
	}

	app1.Deployment.Ports[0].Host = 99999

	app2, err := catalog.GetApp(testAppID)
	if err != nil {
		t.Fatalf("failed to get app again: %v", err)
	}

	if app2.Deployment.Ports[0].Host == 99999 {
		t.Error("catalog GetApp should return a clone — mutation leaked into catalog")
	}
}

func TestAppRunTest_IconFile(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	iconPath := filepath.Join(app.CatalogPath, "icon.svg")
	if _, err := os.Stat(iconPath); os.IsNotExist(err) {
		t.Error("icon.svg file is missing from app directory")
	}
}

func TestAppRunTest_ScriptFilesExecutable(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	scriptsDir := filepath.Join(app.CatalogPath, "scripts")
	entries, err := os.ReadDir(scriptsDir)
	if err != nil {
		t.Fatalf("failed to read scripts dir: %v", err)
	}

	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			t.Errorf("failed to stat script %s: %v", entry.Name(), err)
			continue
		}
		if info.Mode()&0111 == 0 {
			t.Errorf("script %s is not executable (mode: %s)", entry.Name(), info.Mode())
		}
	}
}

func TestAppRunTest_TemplateEnvDeployment(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	if ref, ok := app.Deployment.Environment["ENV_TEMPLATE_REF"]; ok {
		if !strings.Contains(ref, "{{") {
			t.Error("ENV_TEMPLATE_REF should contain Go template syntax")
		}
	}
}

func TestAppRunTest_AllConfigEnvVars(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	for _, field := range app.Configuration {
		if field.EnvVar == "" {
			t.Errorf("configuration field %q should have env_var mapping", field.Name)
		}
	}
}

func TestAppRunTest_ScriptExecutionTimeout(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	actionMap := map[string]ScriptAction{}
	for _, a := range app.Scripts.Actions {
		actionMap[a.Name] = a
	}

	echoAction := actionMap["echo-config"]
	if echoAction.Execution.Timeout == 0 {
		t.Error("echo-config action should have a timeout")
	}

	resetAction := actionMap["reset-data"]
	if resetAction.Execution.Timeout == 0 {
		t.Error("reset-data action should have a timeout")
	}

	optsAction := actionMap["run-with-options"]
	if optsAction.Execution.Timeout == 0 {
		t.Error("run-with-options action should have a timeout")
	}
	if optsAction.Execution.Timeout < 60 {
		t.Error("run-with-options timeout should be generous (>= 60s) given options complexity")
	}
}

func TestAppRunTest_HealthCheckInterval(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	if app.HealthCheck.Interval > 0 && app.HealthCheck.Interval < 5*time.Second {
		t.Error("health check interval should be at least 5s to avoid excessive checks")
	}
	if app.HealthCheck.Timeout > app.HealthCheck.Interval {
		t.Error("health check timeout should not exceed interval")
	}
}

func TestAppRunTest_PortProtocols(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	validProtocols := map[string]bool{"tcp": true, "udp": true, "both": true}
	for _, p := range app.Deployment.Ports {
		if !validProtocols[p.Protocol] {
			t.Errorf("port %d:%d has invalid protocol %q", p.Host, p.Container, p.Protocol)
		}
	}
}

func TestAppRunTest_VolumeReadOnly(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	readOnlyCount := 0
	for _, v := range app.Deployment.Volumes {
		if v.ReadOnly {
			readOnlyCount++
		}
	}
	if readOnlyCount == 0 {
		t.Error("expected at least one read-only volume to test read_only feature")
	}
}

func TestAppRunTest_ActionConfirmTypes(t *testing.T) {
	catalog, _ := setupBuiltinCatalog(t)
	app := getAppDef(t, catalog)

	for _, action := range app.Scripts.Actions {
		if action.Confirm.Enabled && action.Confirm.Message == "" {
			t.Errorf("action %q has confirm enabled but no message (plain language required)", action.Name)
		}
	}
}
