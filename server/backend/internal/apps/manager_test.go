package apps

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func TestScanInstalledApp(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	now := time.Now()
	_, err = db.Exec(`INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, pinned_version, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"inst1", "App One", "builtin", "app1", "/path", "running", "healthy", now, now, `{"k":"v"}`, "1.0.0", "")
	if err != nil {
		t.Fatalf("insert app: %v", err)
	}

	row := db.QueryRow(`SELECT id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, pinned_version, error FROM apps WHERE id = ?`, "inst1")
	app, err := scanInstalledApp(row)
	if err != nil {
		t.Fatalf("scan app: %v", err)
	}
	if app.ID != "inst1" || app.AppID != "app1" || app.Config["k"] != "v" || app.PinnedVersion != "1.0.0" {
		t.Fatalf("unexpected app %+v", app)
	}
}

func TestManagerUpdateStatus(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, _ := database.Open(dbPath)
	_ = db.Migrate()
	_, _ = db.Exec(`INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '{}')`,
		"inst2", "App Two", "builtin", "app2", "/path", "stopped", "unknown")

	m := &Manager{db: db}
	if err := m.updateStatus(context.Background(), "inst2", StatusRunning); err != nil {
		t.Fatalf("update status: %v", err)
	}
	var status string
	if err := db.QueryRow(`SELECT status FROM apps WHERE id = ?`, "inst2").Scan(&status); err != nil {
		t.Fatalf("query status: %v", err)
	}
	if status != string(StatusRunning) {
		t.Fatalf("expected running, got %s", status)
	}
}

func TestRegisterNamedBackend(t *testing.T) {
	m := &Manager{
		backendMap:    make(map[string][]string),
		backendByName: make(map[string]map[string][]string),
	}
	m.RegisterNamedBackend("app1", "ui", "http://127.0.0.1:8080")
	m.RegisterNamedBackend("app1", "api", "http://127.0.0.1:8081")
	// Duplicate should be ignored
	m.RegisterNamedBackend("app1", "ui", "http://127.0.0.1:8080")

	if got := m.GetBackendURL("app1"); got != "http://127.0.0.1:8080" {
		t.Fatalf("expected primary backend, got %s", got)
	}
	if got := m.GetBackendByName("app1", "api"); got != "http://127.0.0.1:8081" {
		t.Fatalf("expected api backend, got %s", got)
	}
	if got := len(m.GetBackends("app1")); got != 2 {
		t.Fatalf("expected 2 backends, got %d", got)
	}
}

func TestMergeExposedInfo(t *testing.T) {
	m := &Manager{}

	app := &InstalledApp{
		Config: map[string]interface{}{
			"jwt_secret":     "super-secret-key",
			"admin_password": "admin123",
			"external_url":   "https://app.example.com",
			"other_field":    "not-exposed",
		},
	}

	catalogApp := &AppDefinition{
		ExposedInfo: []ExposedInfoField{
			{
				Name:          "jwt_secret",
				Label:         "JWT Secret",
				Description:   "Secret key for JWT tokens",
				Type:          "password",
				Copyable:      true,
				Revealable:    true,
				MaskByDefault: true,
			},
			{
				Name:          "admin_password",
				Label:         "Admin Password",
				Type:          "password",
				Copyable:      true,
				Revealable:    true,
				MaskByDefault: true,
			},
			{
				Name:          "external_url",
				Label:         "External URL",
				Description:   "Public URL for accessing this app",
				Type:          "url",
				Copyable:      true,
				Revealable:    false,
				MaskByDefault: false,
			},
		},
	}

	merged := m.mergeExposedInfo(app, catalogApp)

	if len(merged) != 3 {
		t.Fatalf("expected 3 exposed info fields, got %d", len(merged))
	}

	jwtInfo, ok := merged["jwt_secret"]
	if !ok {
		t.Fatal("jwt_secret not in merged map")
	}
	if jwtInfo.Label != "JWT Secret" {
		t.Fatalf("expected JWT Secret label, got %s", jwtInfo.Label)
	}
	if jwtInfo.Type != "password" {
		t.Fatalf("expected password type, got %s", jwtInfo.Type)
	}
	if jwtInfo.Value != "super-secret-key" {
		t.Fatalf("expected super-secret-key value, got %v", jwtInfo.Value)
	}
	if !jwtInfo.Copyable {
		t.Fatal("expected copyable to be true")
	}
	if !jwtInfo.Revealable {
		t.Fatal("expected revealable to be true")
	}
	if !jwtInfo.MaskByDefault {
		t.Fatal("expected mask_by_default to be true")
	}

	urlInfo := merged["external_url"]
	if urlInfo.Type != "url" {
		t.Fatalf("expected url type, got %s", urlInfo.Type)
	}
	if urlInfo.MaskByDefault {
		t.Fatal("expected mask_by_default to be false for url")
	}

	if _, exists := merged["other_field"]; exists {
		t.Fatal("other_field should not be in exposed info")
	}
}

func TestMergeExposedInfoGroupingAndAdvanced(t *testing.T) {
	m := &Manager{}

	app := &InstalledApp{
		Config: map[string]interface{}{
			"api_key":      "key-123",
			"internal_id":  "id-456",
			"advanced_val": "secret-val",
		},
	}

	catalogApp := &AppDefinition{
		ExposedInfo: []ExposedInfoField{
			{
				Name:     "api_key",
				Label:    "API Key",
				Type:     "password",
				Group:    "credentials",
				Advanced: false,
			},
			{
				Name:     "internal_id",
				Label:    "Internal ID",
				Type:     "string",
				Group:    "connection",
				Advanced: false,
			},
			{
				Name:     "advanced_val",
				Label:    "Advanced Val",
				Type:     "password",
				Group:    "credentials",
				Advanced: true,
			},
		},
	}

	merged := m.mergeExposedInfo(app, catalogApp)

	if len(merged) != 3 {
		t.Fatalf("expected 3 exposed info fields, got %d", len(merged))
	}

	apiKey := merged["api_key"]
	if apiKey.Group != "credentials" {
		t.Fatalf("expected credentials group, got %s", apiKey.Group)
	}
	if apiKey.Advanced {
		t.Fatal("expected api_key not to be advanced")
	}

	internalID := merged["internal_id"]
	if internalID.Group != "connection" {
		t.Fatalf("expected connection group, got %s", internalID.Group)
	}

	advancedVal := merged["advanced_val"]
	if advancedVal.Group != "credentials" {
		t.Fatalf("expected credentials group, got %s", advancedVal.Group)
	}
	if !advancedVal.Advanced {
		t.Fatal("expected advanced_val to be advanced")
	}
}

func TestMergeExposedInfoEmptyConfig(t *testing.T) {
	m := &Manager{}

	app := &InstalledApp{
		Config: map[string]interface{}{},
	}

	catalogApp := &AppDefinition{
		ExposedInfo: []ExposedInfoField{
			{Name: "jwt_secret", Label: "JWT Secret", Type: "password"},
		},
	}

	merged := m.mergeExposedInfo(app, catalogApp)

	if len(merged) != 0 {
		t.Fatalf("expected 0 exposed info fields for empty config, got %d", len(merged))
	}
}

func TestMergeExposedInfoNoExposedInfoFields(t *testing.T) {
	m := &Manager{}

	app := &InstalledApp{
		Config: map[string]interface{}{
			"jwt_secret": "secret",
		},
	}

	catalogApp := &AppDefinition{
		ExposedInfo: nil,
	}

	merged := m.mergeExposedInfo(app, catalogApp)

	if len(merged) != 0 {
		t.Fatalf("expected 0 exposed info fields when catalog has none, got %d", len(merged))
	}
}
