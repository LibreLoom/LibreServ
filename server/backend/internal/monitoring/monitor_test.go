package monitoring

import (
	"context"
	"errors"
	"io"
	"path/filepath"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	rt "gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
)

// fakeRuntime is a scripted rt.ContainerRuntime for monitoring tests.
type fakeRuntime struct {
	containers []rt.ContainerInfo
	listErr    error
	stats      map[string]*rt.ContainerStats
	statsErr   error
	inspect    *rt.ContainerInspectResult
	inspectErr error
}

var _ rt.ContainerRuntime = (*fakeRuntime)(nil)

func (f *fakeRuntime) ComposeUp(context.Context, string) error   { return nil }
func (f *fakeRuntime) ComposeDown(context.Context, string) error { return nil }
func (f *fakeRuntime) ComposePull(context.Context, string) error { return nil }
func (f *fakeRuntime) ComposeStop(context.Context, string) error { return nil }

func (f *fakeRuntime) ListContainersByLabel(ctx context.Context, _ string) ([]rt.ContainerInfo, error) {
	return f.ListContainersAll(ctx)
}

func (f *fakeRuntime) ListContainersAll(context.Context) ([]rt.ContainerInfo, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.containers, nil
}

func (f *fakeRuntime) GetContainerStats(_ context.Context, containerID string) (*rt.ContainerStats, error) {
	if f.statsErr != nil {
		return nil, f.statsErr
	}
	stats, ok := f.stats[containerID]
	if !ok {
		return nil, errors.New("no stats for container")
	}
	return stats, nil
}

func (f *fakeRuntime) InspectContainer(context.Context, string) (*rt.ContainerInspectResult, error) {
	if f.inspectErr != nil {
		return nil, f.inspectErr
	}
	return f.inspect, nil
}

func (f *fakeRuntime) ContainerLogs(context.Context, string, rt.LogOptions) (io.ReadCloser, error) {
	return nil, errors.New("not implemented")
}

func (f *fakeRuntime) FindContainersByInstanceID(ctx context.Context, _ string) ([]rt.ContainerInfo, error) {
	return f.ListContainersAll(ctx)
}

func (f *fakeRuntime) HealthCheck() error { return nil }
func (f *fakeRuntime) Close() error       { return nil }

func newTestDB(t *testing.T) *database.DB {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func insertApp(t *testing.T, db *database.DB, appID, status string) {
	t.Helper()
	_, err := db.Exec(
		`INSERT INTO apps (id, name, type, path, status) VALUES (?, ?, 'repo', ?, ?)`,
		appID, appID, "/tmp/"+appID, status,
	)
	if err != nil {
		t.Fatalf("insert app: %v", err)
	}
}

func insertHealthCheck(t *testing.T, db *database.DB, appID string, status HealthStatus, checkedAt time.Time) {
	t.Helper()
	_, err := db.Exec(
		`INSERT INTO health_checks (app_id, check_type, status, message, checked_at) VALUES (?, 'http', ?, '', ?)`,
		appID, string(status), checkedAt,
	)
	if err != nil {
		t.Fatalf("insert health check: %v", err)
	}
}

func TestMetricsCollector_CollectAppMetrics_AggregatesMatchingContainers(t *testing.T) {
	fake := &fakeRuntime{
		containers: []rt.ContainerInfo{
			{ID: "c1", Names: []string{"/myapp_web_1"}},
			{ID: "c2", Labels: map[string]string{"com.docker.compose.project": "myapp"}},
			{ID: "c3", Names: []string{"/otherapp"}},
		},
		stats: map[string]*rt.ContainerStats{
			"c1": {CPUPercent: 10, MemoryUsage: 100, MemoryLimit: 1000, NetworkRx: 1, NetworkTx: 2},
			"c2": {CPUPercent: 5, MemoryUsage: 50, MemoryLimit: 500, NetworkRx: 3, NetworkTx: 4},
			"c3": {CPUPercent: 90, MemoryUsage: 900, MemoryLimit: 9000},
		},
	}

	got, err := NewMetricsCollector(fake).CollectAppMetrics(context.Background(), "myapp")
	if err != nil {
		t.Fatalf("CollectAppMetrics: %v", err)
	}
	if got.AppID != "myapp" {
		t.Errorf("AppID = %q, want myapp", got.AppID)
	}
	if got.CPUPercent != 15 {
		t.Errorf("CPUPercent = %v, want 15", got.CPUPercent)
	}
	if got.MemoryUsage != 150 || got.MemoryLimit != 1500 {
		t.Errorf("memory = %d/%d, want 150/1500", got.MemoryUsage, got.MemoryLimit)
	}
	if got.NetworkRx != 4 || got.NetworkTx != 6 {
		t.Errorf("network = %d/%d, want 4/6", got.NetworkRx, got.NetworkTx)
	}
}

func TestMetricsCollector_CollectAppMetrics_NoContainers(t *testing.T) {
	fake := &fakeRuntime{containers: []rt.ContainerInfo{{ID: "c1", Names: []string{"/otherapp"}}}}

	_, err := NewMetricsCollector(fake).CollectAppMetrics(context.Background(), "myapp")
	if !IsNoContainers(err) {
		t.Fatalf("error = %v, want ErrNoContainers", err)
	}
}

func TestMetricsCollector_CollectAppMetrics_ListError(t *testing.T) {
	fake := &fakeRuntime{listErr: errors.New("socket closed")}

	_, err := NewMetricsCollector(fake).CollectAppMetrics(context.Background(), "myapp")
	if !IsRuntimeUnavailable(err) {
		t.Fatalf("error = %v, want ErrRuntimeUnavailable", err)
	}
}

func TestMetricsCollector_CollectAppMetrics_SkipsContainersWithoutStats(t *testing.T) {
	fake := &fakeRuntime{
		containers: []rt.ContainerInfo{
			{ID: "c1", Names: []string{"/myapp_web_1"}},
			{ID: "missing-stats", Names: []string{"/myapp_db_1"}},
		},
		stats: map[string]*rt.ContainerStats{
			"c1": {CPUPercent: 7, MemoryUsage: 70},
		},
	}

	got, err := NewMetricsCollector(fake).CollectAppMetrics(context.Background(), "myapp")
	if err != nil {
		t.Fatalf("CollectAppMetrics: %v", err)
	}
	if got.CPUPercent != 7 || got.MemoryUsage != 70 {
		t.Fatalf("metrics = %v/%d, want 7/70", got.CPUPercent, got.MemoryUsage)
	}
}

func TestMetricsCollector_CollectContainerMetrics(t *testing.T) {
	fake := &fakeRuntime{
		stats: map[string]*rt.ContainerStats{
			"c1": {CPUPercent: 12.5, MemoryUsage: 200, MemoryLimit: 400, NetworkRx: 8, NetworkTx: 9},
		},
	}

	got, err := NewMetricsCollector(fake).CollectContainerMetrics(context.Background(), "c1")
	if err != nil {
		t.Fatalf("CollectContainerMetrics: %v", err)
	}
	if got.CPUPercent != 12.5 || got.MemoryUsage != 200 || got.MemoryLimit != 400 {
		t.Errorf("metrics = %+v, want cpu 12.5, mem 200/400", got)
	}
	if got.NetworkRx != 8 || got.NetworkTx != 9 {
		t.Errorf("network = %d/%d, want 8/9", got.NetworkRx, got.NetworkTx)
	}
}

func TestMetricsCollector_CollectSystemMetrics(t *testing.T) {
	fake := &fakeRuntime{
		containers: []rt.ContainerInfo{{ID: "c1"}, {ID: "c2"}},
		stats: map[string]*rt.ContainerStats{
			"c1": {CPUPercent: 1, MemoryUsage: 10, MemoryLimit: 100, NetworkRx: 5, NetworkTx: 6},
			"c2": {CPUPercent: 2, MemoryUsage: 20, MemoryLimit: 200, NetworkRx: 7, NetworkTx: 8},
		},
	}

	got, err := NewMetricsCollector(fake).CollectSystemMetrics(context.Background())
	if err != nil {
		t.Fatalf("CollectSystemMetrics: %v", err)
	}
	if got.RunningContainers != 2 {
		t.Errorf("RunningContainers = %d, want 2", got.RunningContainers)
	}
	if got.CPUPercent != 3 || got.MemoryUsage != 30 || got.MemoryLimit != 300 {
		t.Errorf("aggregate = %+v, want cpu 3, mem 30/300", got)
	}
	if got.NetworkRx != 12 || got.NetworkTx != 14 {
		t.Errorf("network = %d/%d, want 12/14", got.NetworkRx, got.NetworkTx)
	}
}

func TestMetricsCollector_CollectSystemMetrics_RuntimeUnavailable(t *testing.T) {
	_, err := NewMetricsCollector(nil).CollectSystemMetrics(context.Background())
	if !IsRuntimeUnavailable(err) {
		t.Fatalf("error = %v, want ErrRuntimeUnavailable", err)
	}
}

func TestMonitor_RegisterApp_RequiresRuntimeForContainerChecks(t *testing.T) {
	m := NewMonitor(newTestDB(t), nil, t.TempDir())

	err := m.RegisterApp("myapp", HealthCheckConfig{Container: &ContainerCheckConfig{ContainerName: "myapp"}})
	if !IsRuntimeUnavailable(err) {
		t.Fatalf("error = %v, want ErrRuntimeUnavailable", err)
	}

	// No explicit checks means the monitor falls back to a container check, which also needs a runtime.
	if err := m.RegisterApp("myapp", HealthCheckConfig{}); !IsRuntimeUnavailable(err) {
		t.Fatalf("error = %v, want ErrRuntimeUnavailable", err)
	}
}

func TestMonitor_RegisterApp_AppliesDefaultsAndRecordsChecks(t *testing.T) {
	db := newTestDB(t)
	insertApp(t, db, "myapp", "running")

	m := NewMonitor(db, nil, t.TempDir())
	cfg := HealthCheckConfig{TCP: &TCPCheckConfig{Host: "127.0.0.1", Port: 1}, Timeout: time.Second}
	if err := m.RegisterApp("myapp", cfg); err != nil {
		t.Fatalf("RegisterApp: %v", err)
	}
	defer m.UnregisterApp("myapp")

	m.checkersMu.RLock()
	checker := m.checkers["myapp"]
	m.checkersMu.RUnlock()
	if checker == nil {
		t.Fatal("checker was not registered")
	}
	if checker.Interval != 30*time.Second {
		t.Errorf("Interval = %v, want the 30s default", checker.Interval)
	}
	if checker.FailureThreshold != 3 || checker.SuccessThreshold != 1 {
		t.Errorf("thresholds = %d/%d, want 3/1", checker.FailureThreshold, checker.SuccessThreshold)
	}
	if len(checker.Checks) != 1 {
		t.Fatalf("checks = %d, want 1 TCP check", len(checker.Checks))
	}

	// Port 1 refuses connections, so repeated checks flip the app to unhealthy and persist rows.
	for i := 0; i < checker.FailureThreshold; i++ {
		m.runCheck(checker)
	}
	if got := checker.GetStatus(); got != HealthStatusUnhealthy {
		t.Fatalf("status = %q, want unhealthy", got)
	}
	if last := checker.GetLastCheck(); last == nil || last.CheckType != "tcp" {
		t.Fatalf("last check = %+v, want a tcp result", last)
	}

	health, err := m.GetAppHealth(context.Background(), "myapp")
	if err != nil {
		t.Fatalf("GetAppHealth: %v", err)
	}
	if health.Status != HealthStatusUnhealthy {
		t.Errorf("health status = %q, want unhealthy", health.Status)
	}
	// RegisterApp also runs one check immediately, so the persisted rows are at least the manual runs.
	if len(health.RecentChecks) < checker.FailureThreshold {
		t.Errorf("recent checks = %d, want at least %d", len(health.RecentChecks), checker.FailureThreshold)
	}
	if health.LastCheck == nil {
		t.Error("LastCheck is nil, want the timestamp of the last run")
	}

	var healthStatus string
	if err := db.QueryRow(`SELECT health_status FROM apps WHERE id = ?`, "myapp").Scan(&healthStatus); err != nil {
		t.Fatalf("query app health: %v", err)
	}
	if healthStatus != string(HealthStatusUnhealthy) {
		t.Errorf("apps.health_status = %q, want unhealthy", healthStatus)
	}
}

func TestMonitor_RunCheck_TriggersRepairAfterFailureThreshold(t *testing.T) {
	db := newTestDB(t)
	insertApp(t, db, "myapp", "running")
	m := NewMonitor(db, nil, t.TempDir())

	repaired := make(chan string, 1)
	m.RepairCallback = func(appID string) { repaired <- appID }

	checker := &HealthChecker{
		AppID:            "myapp",
		Checks:           []Check{staticCheck{"http", HealthStatusUnhealthy}},
		FailureThreshold: 2,
		SuccessThreshold: 1,
		Timeout:          time.Second,
		currentStatus:    HealthStatusUnknown,
		stopCh:           make(chan struct{}),
	}

	m.runCheck(checker)
	if len(repaired) != 0 {
		t.Fatal("repair triggered before the failure threshold was reached")
	}
	m.runCheck(checker)

	select {
	case appID := <-repaired:
		if appID != "myapp" {
			t.Fatalf("repaired app = %q, want myapp", appID)
		}
	default:
		t.Fatal("repair callback was not called after the failure threshold")
	}
}

func TestMonitor_RunCheck_RecoversToHealthy(t *testing.T) {
	db := newTestDB(t)
	insertApp(t, db, "myapp", "running")
	m := NewMonitor(db, nil, t.TempDir())

	checker := &HealthChecker{
		AppID:            "myapp",
		Checks:           []Check{staticCheck{"http", HealthStatusUnhealthy}},
		FailureThreshold: 1,
		SuccessThreshold: 2,
		Timeout:          time.Second,
		currentStatus:    HealthStatusUnknown,
		stopCh:           make(chan struct{}),
	}

	m.runCheck(checker)
	if got := checker.GetStatus(); got != HealthStatusUnhealthy {
		t.Fatalf("status = %q, want unhealthy", got)
	}

	checker.Checks = []Check{staticCheck{"http", HealthStatusHealthy}}
	m.runCheck(checker)
	if got := checker.GetStatus(); got != HealthStatusUnhealthy {
		t.Fatalf("status after 1 success = %q, want unhealthy (success threshold is 2)", got)
	}
	m.runCheck(checker)
	if got := checker.GetStatus(); got != HealthStatusHealthy {
		t.Fatalf("status after 2 successes = %q, want healthy", got)
	}
}

func TestMonitor_RunCheck_CompositeWhenMultipleChecks(t *testing.T) {
	db := newTestDB(t)
	insertApp(t, db, "myapp", "running")
	m := NewMonitor(db, nil, t.TempDir())

	checker := &HealthChecker{
		AppID:            "myapp",
		Checks:           []Check{staticCheck{"http", HealthStatusHealthy}, staticCheck{"tcp", HealthStatusDegraded}},
		FailureThreshold: 1,
		SuccessThreshold: 1,
		Timeout:          time.Second,
		currentStatus:    HealthStatusUnknown,
		stopCh:           make(chan struct{}),
	}

	m.runCheck(checker)
	if got := checker.GetStatus(); got != HealthStatusDegraded {
		t.Fatalf("status = %q, want degraded", got)
	}
	if last := checker.GetLastCheck(); last == nil || last.CheckType != "composite" {
		t.Fatalf("last check = %+v, want a composite result", last)
	}
}

func TestMonitor_UnregisterApp(t *testing.T) {
	db := newTestDB(t)
	m := NewMonitor(db, nil, t.TempDir())

	if err := m.RegisterApp("myapp", HealthCheckConfig{HTTP: &HTTPCheckConfig{URL: "http://127.0.0.1:1"}, Interval: time.Hour}); err != nil {
		t.Fatalf("RegisterApp: %v", err)
	}
	m.UnregisterApp("myapp")

	m.checkersMu.RLock()
	_, ok := m.checkers["myapp"]
	m.checkersMu.RUnlock()
	if ok {
		t.Fatal("checker still registered after UnregisterApp")
	}

	// Unregistering an unknown app is a no-op rather than a panic.
	m.UnregisterApp("nope")
}

func TestMonitor_GetAppHealth_UnknownApp(t *testing.T) {
	m := NewMonitor(newTestDB(t), nil, t.TempDir())

	health, err := m.GetAppHealth(context.Background(), "ghost")
	if err != nil {
		t.Fatalf("GetAppHealth: %v", err)
	}
	if health.Status != HealthStatusUnknown {
		t.Errorf("status = %q, want unknown", health.Status)
	}
	if health.CurrentMetrics != nil {
		t.Errorf("CurrentMetrics = %+v, want nil without a runtime", health.CurrentMetrics)
	}
	if got := m.GetAppHealthStatus(context.Background(), "ghost"); got != HealthStatusUnknown {
		t.Errorf("GetAppHealthStatus = %q, want unknown", got)
	}
}

func TestMonitor_CalculateAvailability(t *testing.T) {
	db := newTestDB(t)
	m := NewMonitor(db, nil, t.TempDir())
	ctx := context.Background()

	if got := m.CalculateAvailability(ctx, "ghost"); got != 0 {
		t.Errorf("availability for unknown app = %v, want 0", got)
	}

	insertApp(t, db, "running-app", "running")
	if got := m.CalculateAvailability(ctx, "running-app"); got != 0 {
		t.Errorf("availability without checks = %v, want 0", got)
	}

	// 40 healthy checks out of a 100-slot window = 40%.
	now := time.Now()
	for i := 0; i < 40; i++ {
		insertHealthCheck(t, db, "running-app", HealthStatusHealthy, now.Add(-time.Duration(i)*time.Second))
	}
	if got := m.CalculateAvailability(ctx, "running-app"); got != 40 {
		t.Errorf("availability = %v, want 40", got)
	}

	// A full window of healthy checks is 100%.
	insertApp(t, db, "healthy-app", "running")
	for i := 0; i < 100; i++ {
		insertHealthCheck(t, db, "healthy-app", HealthStatusHealthy, now.Add(-time.Duration(i)*time.Second))
	}
	if got := m.CalculateAvailability(ctx, "healthy-app"); got != 100 {
		t.Errorf("availability = %v, want 100", got)
	}
}

func TestMonitor_CalculateAvailability_StoppedAppCountsDowntime(t *testing.T) {
	db := newTestDB(t)
	m := NewMonitor(db, nil, t.TempDir())

	insertApp(t, db, "stopped-app", "stopped")
	// 10 healthy checks, all 10 minutes old: downtime adds 20 missing 30s slots.
	lastCheck := time.Now().Add(-10 * time.Minute)
	for i := 0; i < 10; i++ {
		insertHealthCheck(t, db, "stopped-app", HealthStatusHealthy, lastCheck.Add(-time.Duration(i)*time.Second))
	}

	got := m.CalculateAvailability(context.Background(), "stopped-app")
	if got <= 0 || got >= 100 {
		t.Fatalf("availability = %v, want a value between 0 and 100 that accounts for downtime", got)
	}
	if got > 40 {
		t.Fatalf("availability = %v, want downtime to pull it below the 10/10 check ratio", got)
	}
}

func TestMonitor_GetMetricsHistory(t *testing.T) {
	db := newTestDB(t)
	m := NewMonitor(db, nil, t.TempDir())
	insertApp(t, db, "myapp", "running")

	now := time.Now()
	for i, ts := range []time.Time{now.Add(-2 * time.Hour), now.Add(-time.Minute), now} {
		m.saveMetrics(&Metrics{
			AppID:       "myapp",
			Timestamp:   ts,
			CPUPercent:  float64(i),
			MemoryUsage: uint64(i * 10),
		})
	}

	history, err := m.GetMetricsHistory(context.Background(), "myapp", now.Add(-time.Hour), 10)
	if err != nil {
		t.Fatalf("GetMetricsHistory: %v", err)
	}
	if len(history) != 2 {
		t.Fatalf("history = %d rows, want 2 (the older row is outside the window)", len(history))
	}
	if history[0].Timestamp.Before(history[1].Timestamp) {
		t.Error("history is not ordered newest first")
	}

	limited, err := m.GetMetricsHistory(context.Background(), "myapp", now.Add(-3*time.Hour), 1)
	if err != nil {
		t.Fatalf("GetMetricsHistory: %v", err)
	}
	if len(limited) != 1 {
		t.Fatalf("history with limit 1 = %d rows, want 1", len(limited))
	}
}

func TestMonitor_CleanupOldData(t *testing.T) {
	db := newTestDB(t)
	m := NewMonitor(db, nil, t.TempDir())
	insertApp(t, db, "myapp", "running")

	old := time.Now().Add(-48 * time.Hour)
	recent := time.Now()
	insertHealthCheck(t, db, "myapp", HealthStatusHealthy, old)
	insertHealthCheck(t, db, "myapp", HealthStatusHealthy, recent)
	m.saveMetrics(&Metrics{AppID: "myapp", Timestamp: old})
	m.saveMetrics(&Metrics{AppID: "myapp", Timestamp: recent})

	if err := m.CleanupOldData(24 * time.Hour); err != nil {
		t.Fatalf("CleanupOldData: %v", err)
	}

	var checks, metrics int
	if err := db.QueryRow(`SELECT COUNT(*) FROM health_checks`).Scan(&checks); err != nil {
		t.Fatalf("count health checks: %v", err)
	}
	if err := db.QueryRow(`SELECT COUNT(*) FROM metrics`).Scan(&metrics); err != nil {
		t.Fatalf("count metrics: %v", err)
	}
	if checks != 1 {
		t.Errorf("health checks = %d, want 1", checks)
	}
	if metrics != 1 {
		t.Errorf("metrics = %d, want 1", metrics)
	}
}

func TestMonitor_CollectAndCacheSystemResources(t *testing.T) {
	db := newTestDB(t)
	fake := &fakeRuntime{
		containers: []rt.ContainerInfo{{ID: "c1", Names: []string{"/myapp"}}},
		stats: map[string]*rt.ContainerStats{
			"c1": {CPUPercent: 50, MemoryUsage: 500, MemoryLimit: 1000, NetworkRx: 10, NetworkTx: 10},
		},
	}
	m := NewMonitor(db, fake, t.TempDir())

	if m.GetCachedSystemResources() != nil {
		t.Fatal("cache should be empty before the first collection")
	}

	m.CollectAndCacheSystemResourcesSync()
	cached := m.GetCachedSystemResources()
	if cached == nil {
		t.Fatal("cache is nil after collection")
	}
	if cached.RunningContainers != 1 {
		t.Errorf("RunningContainers = %d, want 1", cached.RunningContainers)
	}
	if got := cached.Resources["ram"]; got != 0.5 {
		t.Errorf("ram = %v, want 0.5 (500 of 1000 bytes)", got)
	}
	for _, key := range []string{"cpu", "ram", "disk", "net"} {
		v, ok := cached.Resources[key]
		if !ok {
			t.Errorf("resource %q missing", key)
			continue
		}
		if v < 0 || v > 1 {
			t.Errorf("resource %q = %v, want a fraction in [0,1]", key, v)
		}
	}
	if cached.SystemMetrics["running_containers"] != 1 {
		t.Errorf("SystemMetrics[running_containers] = %v, want 1", cached.SystemMetrics["running_containers"])
	}
}

func TestMonitor_CollectAndCacheSystemResources_FallsBackToHostWhenRuntimeUnavailable(t *testing.T) {
	m := NewMonitor(newTestDB(t), nil, t.TempDir())

	m.CollectAndCacheSystemResourcesSync()
	cached := m.GetCachedSystemResources()
	if cached == nil {
		t.Fatal("cache is nil after collection")
	}
	if cached.RunningContainers != 0 {
		t.Errorf("RunningContainers = %d, want 0 without a runtime", cached.RunningContainers)
	}
	if _, ok := cached.SystemMetrics["host_memory_usage"]; !ok {
		t.Error("SystemMetrics is missing host_memory_usage, so host fallback metrics were not recorded")
	}
}

func TestMonitor_CollectAllMetrics_PersistsRegisteredApps(t *testing.T) {
	db := newTestDB(t)
	insertApp(t, db, "myapp", "running")
	fake := &fakeRuntime{
		containers: []rt.ContainerInfo{{ID: "c1", Names: []string{"/myapp"}}},
		stats:      map[string]*rt.ContainerStats{"c1": {CPUPercent: 3, MemoryUsage: 30, MemoryLimit: 300}},
	}
	m := NewMonitor(db, fake, t.TempDir())

	if err := m.RegisterApp("myapp", HealthCheckConfig{Interval: time.Hour, Timeout: time.Second}); err != nil {
		t.Fatalf("RegisterApp: %v", err)
	}
	defer m.UnregisterApp("myapp")

	m.collectAllMetrics()

	var count int
	if err := db.QueryRow(`SELECT COUNT(*) FROM metrics WHERE app_id = ?`, "myapp").Scan(&count); err != nil {
		t.Fatalf("count metrics: %v", err)
	}
	if count != 1 {
		t.Fatalf("metrics rows = %d, want 1", count)
	}
}

func TestMonitor_StartStop_WithoutRuntimeIsNoop(t *testing.T) {
	m := NewMonitor(newTestDB(t), nil, t.TempDir())
	m.Start()
	m.Stop() // Stop must return even though Start never launched the loop.
}

func TestMonitor_MetricsCollectorAccessor(t *testing.T) {
	m := NewMonitor(newTestDB(t), nil, t.TempDir())
	if m.MetricsCollector() == nil {
		t.Fatal("MetricsCollector() = nil")
	}
}
