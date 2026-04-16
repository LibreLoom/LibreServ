package apps

import (
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
	"log/slog"
)

// Minimal smoke test for installer ValidateConfig.
func TestInstallerValidateConfig(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	catalog := &Catalog{apps: map[string]*AppDefinition{
		"app1": {
			ID: "app1",
			Deployment: DeploymentConfig{
				Image: "alpine",
			},
			Configuration: []ConfigField{
				{Name: "required_field", Label: "Required", Required: true, Type: "string"},
			},
		},
	}}

	inst := NewInstaller(catalog, docker.NewRuntimeAdapter(&docker.Client{}), db, dir, monitoring.NewMonitor(db, nil, ""), NewAppMetricsCache(monitoring.NewMonitor(db, nil, ""), slog.Default()), nil)

	err = inst.ValidateConfig("app1", map[string]interface{}{"required_field": "ok"})
	if err != nil {
		t.Fatalf("expected valid config, got %v", err)
	}
	if err := inst.ValidateConfig("app1", map[string]interface{}{}); err == nil {
		t.Fatalf("expected error for missing required field")
	}
}
