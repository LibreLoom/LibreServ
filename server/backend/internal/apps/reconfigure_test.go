package apps

import (
	"context"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
)

type mockRuntime struct {
	downCalls  int
	upCalls    int
	pullCalls  int
	stopCalls  int
	upErr      error
	downErr    error
	containers []runtime.ContainerInfo
}

func (m *mockRuntime) ComposeUp(_ context.Context, _ string) error   { m.upCalls++; return m.upErr }
func (m *mockRuntime) ComposeDown(_ context.Context, _ string) error { m.downCalls++; return m.downErr }
func (m *mockRuntime) ComposePull(_ context.Context, _ string) error { m.pullCalls++; return nil }
func (m *mockRuntime) ComposeStop(_ context.Context, _ string) error { m.stopCalls++; return nil }

func (m *mockRuntime) ListContainersByLabel(_ context.Context, _ string) ([]runtime.ContainerInfo, error) {
	return m.containers, nil
}
func (m *mockRuntime) ListContainersAll(_ context.Context) ([]runtime.ContainerInfo, error) {
	return m.containers, nil
}
func (m *mockRuntime) GetContainerStats(_ context.Context, _ string) (*runtime.ContainerStats, error) {
	return &runtime.ContainerStats{}, nil
}
func (m *mockRuntime) InspectContainer(_ context.Context, _ string) (*runtime.ContainerInspectResult, error) {
	return &runtime.ContainerInspectResult{}, nil
}
func (m *mockRuntime) ContainerLogs(_ context.Context, _ string, _ runtime.LogOptions) (io.ReadCloser, error) {
	return io.NopCloser(nil), nil
}
func (m *mockRuntime) FindContainersByInstanceID(_ context.Context, _ string) ([]runtime.ContainerInfo, error) {
	return m.containers, nil
}
func (m *mockRuntime) HealthCheck() error { return nil }
func (m *mockRuntime) Close() error       { return nil }

// setupReconfigureTest creates a manager with a mock runtime, a catalog with
// the apprun-test app, and an installed app in the DB. Returns the manager,
// the mock runtime, and cleanup.
func setupReconfigureTest(t *testing.T) (*Manager, *mockRuntime, string, func()) {
	t.Helper()

	candidate := filepath.Join("testdata")
	if _, err := os.Stat(candidate); os.IsNotExist(err) {
		candidate = filepath.Join("internal", "apps", "testdata")
	}
	absPath, err := filepath.Abs(candidate)
	if err != nil {
		t.Fatalf("resolve testdata: %v", err)
	}
	if _, err := os.Stat(absPath); os.IsNotExist(err) {
		t.Skip("testdata directory not found — skipping reconfigure test")
	}

	catalog, err := NewCatalog(absPath)
	if err != nil {
		t.Fatalf("load catalog: %v", err)
	}

	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	appsDataDir := filepath.Join(dir, "apps")
	installPath := filepath.Join(appsDataDir, "inst-reconf")
	if err := os.MkdirAll(installPath, 0o755); err != nil {
		t.Fatalf("mkdir install path: %v", err)
	}

	// Write an initial compose file so processComposeTemplate overwrites it.
	_ = os.WriteFile(filepath.Join(installPath, "docker-compose.yml"), []byte("# initial\n"), 0o600)

	// Insert an installed app with existing config.
	existingConfig := `{"http_port":8880,"api_port":8881,"metrics_port":8882,"string_field":"hello-world","password_field":"secret123","number_field":42,"boolean_field":true,"select_field":"standard","validated_field":"abc123","version":"1.0.0","instance_id":"inst-reconf","install_path":"` + installPath + `","_compose_template_sha":"oldsha"}`
	_, err = db.Exec(`INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, compose_template_sha) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?, ?)`,
		"inst-reconf", "AppRun Test Suite", "repo", "apprun-test", installPath, "running", "healthy", existingConfig, "oldsha")
	if err != nil {
		t.Fatalf("insert app: %v", err)
	}

	mrt := &mockRuntime{
		containers: []runtime.ContainerInfo{
			{ID: "c1", Names: []string{"inst-reconf-1"}, State: "running", Status: "Up", Labels: map[string]string{"com.libreserv.instance": "inst-reconf"}},
		},
	}

	installer := &Installer{
		catalog:     catalog,
		runtime:     mrt,
		db:          db,
		appsDataDir: appsDataDir,
		catalogPath: absPath,
		logger:      slog.Default().With("component", "test-installer"),
		serverCtx:   ServerContext{ServerPort: 8080, ServerMode: "dev", DefaultDomain: "test.local"},
	}

	m := &Manager{
		catalog:     catalog,
		installer:   installer,
		runtime:     mrt,
		db:          db,
		appsDataDir: appsDataDir,
		logger:      slog.Default().With("component", "test-manager"),
		updating:    make(map[string]bool),
	}

	cleanup := func() {
		_ = db.Close()
	}

	return m, mrt, installPath, cleanup
}

func TestReconfigure_UpdatesConfigAndRestarts(t *testing.T) {
	m, mrt, installPath, cleanup := setupReconfigureTest(t)
	defer cleanup()

	// Change string_field and select_field.
	userConfig := map[string]interface{}{
		"string_field": "updated-value",
		"select_field": "advanced",
	}

	ctx := context.Background()
	if err := m.Reconfigure(ctx, "inst-reconf", userConfig); err != nil {
		t.Fatalf("Reconfigure: %v", err)
	}

	// ComposeDown + ComposeUp should have been called.
	if mrt.downCalls != 1 {
		t.Errorf("expected 1 ComposeDown call, got %d", mrt.downCalls)
	}
	if mrt.upCalls != 1 {
		t.Errorf("expected 1 ComposeUp call, got %d", mrt.upCalls)
	}

	// The compose file should have been re-rendered.
	composeData, err := os.ReadFile(filepath.Join(installPath, "docker-compose.yml"))
	if err != nil {
		t.Fatalf("read compose file: %v", err)
	}
	if len(composeData) == 0 {
		t.Error("compose file should not be empty after reconfigure")
	}

	// The DB metadata should reflect the updated config.
	app, err := m.GetInstalledApp(ctx, "inst-reconf")
	if err != nil {
		t.Fatalf("GetInstalledApp: %v", err)
	}
	if v, _ := app.Config["string_field"].(string); v != "updated-value" {
		t.Errorf("expected string_field=updated-value, got %v", app.Config["string_field"])
	}
	if v, _ := app.Config["select_field"].(string); v != "advanced" {
		t.Errorf("expected select_field=advanced, got %v", app.Config["select_field"])
	}

	// Internal keys should be preserved.
	if v, ok := app.Config["instance_id"].(string); !ok || v != "inst-reconf" {
		t.Errorf("expected instance_id=inst-reconf, got %v", app.Config["instance_id"])
	}
	if _, ok := app.Config["version"]; !ok {
		t.Error("version key should be preserved")
	}
}

func TestReconfigure_PreservesPasswordWhenEmpty(t *testing.T) {
	m, _, _, cleanup := setupReconfigureTest(t)
	defer cleanup()

	// Send empty string for password_field — should keep existing "secret123".
	userConfig := map[string]interface{}{
		"password_field": "",
	}

	ctx := context.Background()
	if err := m.Reconfigure(ctx, "inst-reconf", userConfig); err != nil {
		t.Fatalf("Reconfigure: %v", err)
	}

	// The password is preserved in the merged config; verify it's in the DB metadata.
	// password_field is a secret key — it's stripped by RedactForAPI.
	// But GetInstalledApp returns the raw config from DB (which strips
	// secrets via stripServerContext). We need to check the raw DB value.
	var metadata string
	if err := m.db.QueryRow(`SELECT metadata FROM apps WHERE id = ?`, "inst-reconf").Scan(&metadata); err != nil {
		t.Fatalf("query metadata: %v", err)
	}
	// The password should still be present in the DB because the merged config
	// preserved the existing value (stripServerContext only strips "server"
	// and oidc_client_secret, not arbitrary password fields).
	if !contains(metadata, "secret123") {
		t.Errorf("expected password_field to retain existing value 'secret123', metadata: %s", metadata)
	}
}

func TestReconfigure_DropsUnknownKeys(t *testing.T) {
	m, _, _, cleanup := setupReconfigureTest(t)
	defer cleanup()

	// Try to inject an internal key via user config.
	userConfig := map[string]interface{}{
		"string_field":          "new-value",
		"instance_id":           "hacked",
		"_compose_template_sha": "tampered",
	}

	ctx := context.Background()
	if err := m.Reconfigure(ctx, "inst-reconf", userConfig); err != nil {
		t.Fatalf("Reconfigure: %v", err)
	}

	app, err := m.GetInstalledApp(ctx, "inst-reconf")
	if err != nil {
		t.Fatalf("GetInstalledApp: %v", err)
	}
	if v, _ := app.Config["instance_id"].(string); v != "inst-reconf" {
		t.Errorf("instance_id should not be overridable, got %v", app.Config["instance_id"])
	}
	if v, _ := app.Config["string_field"].(string); v != "new-value" {
		t.Errorf("string_field should be updated, got %v", app.Config["string_field"])
	}
}

func TestReconfigure_RejectsInvalidConfig(t *testing.T) {
	m, _, _, cleanup := setupReconfigureTest(t)
	defer cleanup()

	// select_field only accepts basic/standard/advanced.
	userConfig := map[string]interface{}{
		"select_field": "invalid-option",
	}

	ctx := context.Background()
	err := m.Reconfigure(ctx, "inst-reconf", userConfig)
	if err == nil {
		t.Fatal("expected validation error for invalid select option")
	}
}

func TestReconfigure_PreventsConcurrentOperation(t *testing.T) {
	m, _, _, cleanup := setupReconfigureTest(t)
	defer cleanup()

	ctx := context.Background()

	// Simulate an in-progress update.
	m.updateMu.Lock()
	m.updating["inst-reconf"] = true
	m.updateMu.Unlock()

	err := m.Reconfigure(ctx, "inst-reconf", map[string]interface{}{"string_field": "x"})
	if err == nil {
		t.Fatal("expected error for concurrent reconfigure")
	}
}

func contains(s, substr string) bool {
	return strings.Contains(s, substr)
}
