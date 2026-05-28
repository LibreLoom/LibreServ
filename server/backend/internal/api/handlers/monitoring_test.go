package handlers

import (
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/monitoring"
)

func newTestMonitoringHandlers(t *testing.T) *MonitoringHandlers {
	t.Helper()

	origCfg := config.Get()
	config.SetTestConfig(&config.Config{})
	t.Cleanup(func() {
		config.SetTestConfig(origCfg)
	})

	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	mon := monitoring.NewMonitor(db, nil, dir)
	metricsCache := apps.NewAppMetricsCache(mon, slog.Default())

	return NewMonitoringHandlers(mon, db, nil, metricsCache)
}

func TestSystemHealth(t *testing.T) {
	h := newTestMonitoringHandlers(t)

	rr := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/system/health", nil)
	h.SystemHealth(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", rr.Code)
	}
}
