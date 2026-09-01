package apps

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func openAppsCoverageDB(t *testing.T) *database.DB {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "apps.db"))
	if err != nil {
		t.Fatalf("open database: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func writeExecutable(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o750); err != nil {
		t.Fatalf("create script directory: %v", err)
	}
	if err := os.WriteFile(path, []byte("#!/bin/sh\n"+body), 0o750); err != nil {
		t.Fatalf("write script: %v", err)
	}
}

func TestScriptExecutorExecutionPaths(t *testing.T) {
	base := t.TempDir()
	installPath := filepath.Join(base, "instance")
	scriptPath := filepath.Join(installPath, "scripts", "success")
	writeExecutable(t, scriptPath, `printf 'setup log\n'
printf '{"answer":42,"exposed_info":{"url":"https://example.test","port":8080,"ready":true,"bad":[1]}}\n'
`)

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	executor := NewScriptExecutorWithCatalog(logger, nil, base, "")
	executor.SetServerContext(ServerContext{ServerURL: "https://server.test", SMTPPassword: "secret"})

	result, err := executor.ExecuteAt(context.Background(), "instance_1", scriptPath, installPath, map[string]interface{}{"mode": "fast"})
	if err != nil {
		t.Fatalf("execute success script: %v", err)
	}
	if !result.Success || result.ExitCode != 0 || result.Data["answer"] != float64(42) {
		t.Fatalf("unexpected success result: %+v", result)
	}
	if result.ExposedInfo["url"] != "https://example.test" || result.ExposedInfo["port"] != float64(8080) {
		t.Fatalf("unexpected exposed info: %#v", result.ExposedInfo)
	}
	if _, exists := result.ExposedInfo["bad"]; exists {
		t.Fatalf("non-scalar exposed info was retained: %#v", result.ExposedInfo)
	}
	if _, err := os.Stat(filepath.Join(installPath, "config.json")); !os.IsNotExist(err) {
		t.Fatalf("temporary script config was not removed: %v", err)
	}

	failurePath := filepath.Join(installPath, "scripts", "failure")
	writeExecutable(t, failurePath, "printf 'partial output'; printf 'failure detail' >&2; exit 7\n")
	result, err = executor.Execute(context.Background(), "instance_1", failurePath, nil)
	if err != nil {
		t.Fatalf("execute failing script should return a result, got: %v", err)
	}
	if result.Success || result.ExitCode != 7 || !strings.Contains(result.Error, "partial output") || !strings.Contains(result.Error, "failure detail") {
		t.Fatalf("unexpected failure result: %+v", result)
	}

	if result, err = executor.Execute(context.Background(), "../bad", scriptPath, nil); err == nil || result.Success {
		t.Fatalf("invalid instance ID was accepted: result=%+v err=%v", result, err)
	}

	outside := filepath.Join(t.TempDir(), "outside")
	writeExecutable(t, outside, "exit 0\n")
	if result, err = executor.Execute(context.Background(), "valid", outside, nil); err == nil || result.Error != "Script path validation failed" {
		t.Fatalf("outside script was accepted: result=%+v err=%v", result, err)
	}

	streamPath := filepath.Join(installPath, "scripts", "stream")
	writeExecutable(t, streamPath, "printf 'stream output'; printf 'stream warning' >&2; exit 3\n")
	outputs, err := executor.StreamExecuteAt(context.Background(), "instance_1", streamPath, installPath, map[string]interface{}{"yes": true})
	if err != nil {
		t.Fatalf("stream execute: %v", err)
	}
	var stdout, stderr string
	exitCode := -1
	for output := range outputs {
		switch output.Type {
		case "stdout":
			stdout += output.Content
		case "stderr":
			stderr += output.Content
		case "complete":
			exitCode = output.ExitCode
		}
	}
	if stdout != "stream output" || stderr != "stream warning" || exitCode != 3 {
		t.Fatalf("unexpected stream output: stdout=%q stderr=%q exit=%d", stdout, stderr, exitCode)
	}

	if _, err := executor.StreamExecute(context.Background(), "", scriptPath, nil); err == nil {
		t.Fatal("stream execute accepted empty instance ID")
	}
}

func TestScriptExecutorSchemaConfigAndPathHelpers(t *testing.T) {
	base := t.TempDir()
	catalog := t.TempDir()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	executor := NewScriptExecutorWithCatalog(logger, nil, base, catalog)

	baseScript := filepath.Join(base, "app", "scripts", "action")
	catalogScript := filepath.Join(catalog, "catalog-app", "scripts", "action")
	writeExecutable(t, baseScript, "exit 0\n")
	writeExecutable(t, catalogScript, "exit 0\n")
	for _, path := range []string{baseScript, catalogScript} {
		resolved, err := executor.validateScriptPath(path)
		if err != nil || resolved == "" {
			t.Fatalf("validate allowed script %q: %q, %v", path, resolved, err)
		}
	}

	optsPath := filepath.Join(base, "app", "scripts", "repair.opts")
	if err := os.WriteFile(optsPath, []byte("name: repair\nlabel: Repair app\nconfirm:\n  enabled: true\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	action, err := executor.GetActionSchema(filepath.Join(base, "app"), "repair")
	if err != nil || action == nil || action.Script != "scripts/repair" || !action.Confirm.Enabled {
		t.Fatalf("unexpected action schema: action=%+v err=%v", action, err)
	}
	if action, err = executor.GetActionSchema(filepath.Join(base, "app"), "missing"); err != nil || action != nil {
		t.Fatalf("missing action schema: action=%+v err=%v", action, err)
	}
	if err := os.WriteFile(optsPath, []byte("name: ["), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := executor.GetActionSchema(filepath.Join(base, "app"), "repair"); err == nil {
		t.Fatal("invalid action schema parsed successfully")
	}

	systemSetup := filepath.Join(base, "app", "scripts", "system-setup")
	writeExecutable(t, systemSetup, "exit 0\n")
	if got := executor.GetSystemScriptPath(filepath.Join(base, "app"), "setup"); got != systemSetup {
		t.Fatalf("system setup path = %q, want %q", got, systemSetup)
	}
	if got := executor.GetSystemScriptPath(filepath.Join(base, "app"), "unknown"); got != "" {
		t.Fatalf("unknown system script path = %q", got)
	}
	if got := executor.GetSystemScriptPath(filepath.Join(base, "app"), "repair"); got != "" {
		t.Fatalf("missing system script path = %q", got)
	}

	configPath, installPath, err := executor.prepareScriptConfig("instance", baseScript, "", map[string]interface{}{"flag": true})
	if err != nil {
		t.Fatalf("prepare script config: %v", err)
	}
	defer os.Remove(configPath)
	if installPath != filepath.Join(base, "app") {
		t.Fatalf("derived install path = %q", installPath)
	}
	data, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatal(err)
	}
	var config ScriptExecutionConfig
	if err := json.Unmarshal(data, &config); err != nil {
		t.Fatalf("decode script config: %v", err)
	}
	if config.InstanceID != "instance" || config.Runtime.ProjectName != "libreserv-instance" || config.Options["flag"] != true {
		t.Fatalf("unexpected script config: %+v", config)
	}

	for _, output := range []string{"plain text", `broken {"a":`, `prefix {"a":"}","nested":{"ok":true}} suffix`} {
		got := executor.parseScriptOutput(output)
		if strings.Contains(output, `"nested"`) {
			if got == nil || got["a"] != "}" {
				t.Fatalf("failed to extract nested JSON from %q: %#v", output, got)
			}
		} else if got != nil {
			t.Fatalf("unexpected JSON from %q: %#v", output, got)
		}
	}
}

func TestInstallerPersistenceAndFilesystemHelpers(t *testing.T) {
	db := openAppsCoverageDB(t)
	root := t.TempDir()
	catalogRoot := filepath.Join(root, "catalog", "demo")
	if err := os.MkdirAll(catalogRoot, 0o750); err != nil {
		t.Fatal(err)
	}
	appDef := &AppDefinition{
		ID:          "demo",
		Name:        "Demo",
		Version:     "1.2.3",
		Type:        AppTypeRepo,
		CatalogPath: catalogRoot,
		Configuration: []ConfigField{
			{Name: "title", Type: "string", Default: "default"},
			{Name: "password", Type: "password"},
		},
		Deployment: DeploymentConfig{
			ComposeFile: "compose.yml.tmpl",
			Environment: map[string]string{"INTERNAL": "value"},
			Volumes:     []VolumeMapping{{Name: "media"}, {Name: "data"}},
		},
	}
	catalog := &Catalog{apps: map[string]*AppDefinition{"demo": appDef}}
	installer := NewInstaller(catalog, nil, db, filepath.Join(root, "installed"), nil, nil, NewPortManager(db, catalog, 8080))

	installer.SetCatalogPath(catalogRoot)
	installer.SetCatalog(catalog)
	installer.SetBackendRegistrar(func(string, string, string) {})
	installer.SetRouteCleanup(func(context.Context, string) error { return nil })
	installer.SetDomainConfig(&DomainConfig{Domain: "example.test"})
	installer.ClearDomainConfig()
	installer.SetServerContext(ServerContext{ServerURL: "https://server.test", SMTPHost: "smtp.test", SMTPPort: 2525, SMTPPassword: "secret"})
	installer.SetOIDCProvisioner(func(string, string, string) (string, string, string, error) {
		return "id", "secret", "https://issuer.test", nil
	})

	ch := installer.createInstallOutputChannel("active")
	if installer.GetInstallOutputChannel("active") != ch {
		t.Fatal("active install output channel was not returned")
	}
	installer.removeInstallOutputChannel("active")
	if installer.GetInstallOutputChannel("active") != nil {
		t.Fatal("install output channel was not removed")
	}

	config := installer.mergeConfig(appDef, map[string]interface{}{"title": "custom", "unknown": "drop"})
	config = installer.generateAutoValues(appDef, config)
	if config["title"] != "custom" || config["INTERNAL"] != "value" || len(config["password"].(string)) != 24 {
		t.Fatalf("unexpected merged config: %#v", config)
	}
	if _, exists := config["unknown"]; exists {
		t.Fatalf("unknown config key retained: %#v", config)
	}

	installPath := filepath.Join(root, "installed", "instance")
	if err := installer.createDataDirectories(installPath, appDef); err != nil {
		t.Fatalf("create data directories: %v", err)
	}
	for _, dir := range []string{"data", "config", "logs", filepath.Join("data", "media"), filepath.Join("config", "media")} {
		if info, err := os.Stat(filepath.Join(installPath, dir)); err != nil || !info.IsDir() {
			t.Fatalf("missing data directory %q: %v", dir, err)
		}
	}

	catalogScripts := filepath.Join(catalogRoot, "scripts")
	writeExecutable(t, filepath.Join(catalogScripts, "system-setup"), "exit 0\n")
	if err := os.Mkdir(filepath.Join(catalogScripts, "ignored"), 0o750); err != nil {
		t.Fatal(err)
	}
	if err := installer.copyScripts(installPath, appDef); err != nil {
		t.Fatalf("copy scripts: %v", err)
	}
	if info, err := os.Stat(filepath.Join(installPath, "scripts", "system-setup")); err != nil || info.Mode()&0o100 == 0 {
		t.Fatalf("copied script is missing or not executable: %v", err)
	}
	if err := installer.copyScripts(installPath, &AppDefinition{}); err != nil {
		t.Fatalf("copy scripts without catalog path: %v", err)
	}

	composeTemplate := "services:\n  demo:\n    image: demo\n    environment:\n      URL: '{{serverURL}}'\n      SMTP: '{{smtpHost}}:{{smtpPort}}'\n      VALUE: '{{default \"fallback\" .missing}}'\n      DATA: '{{dataPath}}'\n"
	if err := os.WriteFile(filepath.Join(catalogRoot, "compose.yml.tmpl"), []byte(composeTemplate), 0o600); err != nil {
		t.Fatal(err)
	}
	composePath, err := installer.processComposeTemplate(appDef, installPath, config)
	if err != nil {
		t.Fatalf("process compose template: %v", err)
	}
	composeData, err := os.ReadFile(composePath)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(composeData), "https://server.test") || !strings.Contains(string(composeData), "smtp.test:2525") {
		t.Fatalf("server context missing from compose output: %s", composeData)
	}

	secretConfig := map[string]interface{}{
		"visible":               "yes",
		"server":                map[string]interface{}{"smtp_password": "secret"},
		"oidc_client_secret":    "secret",
		"_compose_template_sha": "sha-from-config",
	}
	if err := installer.createMetadataFile(installPath, appDef, secretConfig); err != nil {
		t.Fatalf("create metadata: %v", err)
	}
	metadataFile, err := os.ReadFile(filepath.Join(installPath, ".libreserv.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(metadataFile), "secret") || !strings.Contains(string(metadataFile), "visible") {
		t.Fatalf("metadata secret filtering failed: %s", metadataFile)
	}

	now := time.Now().UTC().Truncate(time.Second)
	app := &InstalledApp{
		ID:           "instance",
		AppID:        "demo",
		Name:         "Demo",
		Type:         AppTypeRepo,
		Status:       StatusInstalling,
		HealthStatus: HealthUnknown,
		Path:         installPath,
		Config:       secretConfig,
		InstalledAt:  now,
		UpdatedAt:    now,
	}
	if err := installer.saveInstalledApp(app); err != nil {
		t.Fatalf("save installed app: %v", err)
	}
	var storedMetadata, composeSHA string
	if err := db.QueryRow(`SELECT metadata, compose_template_sha FROM apps WHERE id = ?`, app.ID).Scan(&storedMetadata, &composeSHA); err != nil {
		t.Fatalf("read stored app: %v", err)
	}
	if strings.Contains(storedMetadata, "secret") || composeSHA != "sha-from-config" {
		t.Fatalf("stored app was not sanitized: metadata=%s sha=%q", storedMetadata, composeSHA)
	}

	if err := installer.createRoute(context.Background(), appDef, app, &DomainConfig{Domain: "example.test", Subdomain: "demo"}); err != nil {
		t.Fatalf("create route: %v", err)
	}
	if err := installer.createRoute(context.Background(), appDef, app, nil); err != nil {
		t.Fatalf("create empty route: %v", err)
	}
	if err := installer.updateAppStatus(app.ID, StatusError, "failed"); err != nil {
		t.Fatal(err)
	}
	if err := installer.updateAppStatus(app.ID, StatusRunning, ""); err != nil {
		t.Fatal(err)
	}

	if err := os.Remove(composePath); err != nil {
		t.Fatal(err)
	}
	if err := installer.Uninstall(context.Background(), app.ID); err != nil {
		t.Fatalf("uninstall without compose file: %v", err)
	}
	if _, err := os.Stat(installPath); !os.IsNotExist(err) {
		t.Fatalf("install path still exists after uninstall: %v", err)
	}
}

func TestPortManagerMetricsAndAccessHelpers(t *testing.T) {
	db := openAppsCoverageDB(t)
	pm := NewPortManager(db, &Catalog{apps: map[string]*AppDefinition{}}, 8080)

	ports := pm.extractPorts("missing", `{"http_port":12345,"text":"23456","small":80,"bad":"no"}`)
	if len(ports) != 2 {
		t.Fatalf("fallback extracted ports = %v", ports)
	}
	for input, want := range map[interface{}]int{
		12: 12, int64(13): 13, float64(14): 14, float32(15): 15, "16": 16, "bad": 0, true: 0,
	} {
		if got := toInt(input); got != want {
			t.Errorf("toInt(%#v) = %d, want %d", input, got, want)
		}
	}

	for _, port := range []int{-1, 0, 80, 8080, MaxPort + 1} {
		if pm.IsAvailable(port) {
			t.Errorf("reserved or invalid port %d reported available", port)
		}
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	occupied := listener.Addr().(*net.TCPAddr).Port
	if pm.IsPortFreeAtOS(occupied) || pm.IsAvailable(occupied) {
		t.Fatalf("occupied port %d reported free", occupied)
	}
	_ = listener.Close()

	pm.Reserve(12001, "one")
	pm.Reserve(12002, "one")
	pm.Reserve(12003, "two")
	pm.Release(12003)
	pm.ReleaseAll("one")
	if used := pm.GetUsedPorts(); len(used) != 0 {
		t.Fatalf("ports not released: %#v", used)
	}

	cache := NewAppMetricsCache(nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if got := cache.GetMetrics("missing"); got == nil || *got != (AppMetrics{}) {
		t.Fatalf("missing metrics = %+v", got)
	}
	cache.UpdateStatus("app", StatusRunning)
	cache.mu.Lock()
	cache.lastStarted["app"] = time.Now().Add(-2 * time.Second)
	cache.mu.Unlock()
	cache.RefreshNow(context.Background())
	if got := cache.GetMetrics("app"); got.Uptime < 1 {
		t.Fatalf("running app uptime = %d", got.Uptime)
	}
	cache.UpdateStatus("app", StatusStopped)
	cache.mu.Lock()
	cache.lastStopped["app"] = time.Now().Add(-2 * time.Second)
	cache.mu.Unlock()
	cache.RefreshNow(context.Background())
	if got := cache.GetMetrics("app"); got.Downtime < 1 {
		t.Fatalf("stopped app downtime = %d", got.Downtime)
	}
	cache.RemoveApp("app")
	if _, exists := cache.statuses["app"]; exists {
		t.Fatal("app status was not removed")
	}
	cache.Start(context.Background())
	cache.Stop()

	requirement := (Access{
		Web:          true,
		LargeUploads: true,
		Ports:        []PortNeed{{Protocol: "udp", Port: 1234, VerifyHint: "echo"}},
	}).ToNetworkRequirement()
	if !requirement.Web || !requirement.LargeUploads || len(requirement.Ports) != 1 || requirement.Ports[0].Protocol != "udp" {
		t.Fatalf("unexpected network requirement: %+v", requirement)
	}
}
