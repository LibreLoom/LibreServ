package apps

import (
	"context"
	"database/sql"
	"log/slog"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
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
	_, err = db.Exec(`INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, pinned_version, error, image_digest, compose_template_sha, revocation_severity, revocation_reason, revocation_revoked_at, revocation_acknowledged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		"inst1", "App One", "repo", "app1", "/path", "running", "healthy", now, now, `{"k":"v"}`, "1.0.0", "", nil, nil, nil, nil, nil, nil)
	if err != nil {
		t.Fatalf("insert app: %v", err)
	}

	row := db.QueryRow(`SELECT id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, pinned_version, error, image_digest, compose_template_sha, revocation_severity, revocation_reason, revocation_revoked_at, revocation_acknowledged_at FROM apps WHERE id = ?`, "inst1")
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
		"inst2", "App Two", "repo", "app2", "/path", "stopped", "unknown")

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

// TestMigrateAppDomains covers the stale-route bug: when the device's default
// domain changes, each installed app's persisted domain config must be
// rewritten, the old tunnel hostname unregistered, and the new one registered.
func TestMigrateAppDomains(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// App under the OLD default domain — must migrate.
	configJSON := `{"subdomain":"convertx","domain":"test.local","http_port":3002}`
	_, err = db.Exec(`INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
		"app1", "ConvertX", "repo", "convertx", "/path1", "running", "healthy", configJSON)
	if err != nil {
		t.Fatalf("insert app1: %v", err)
	}
	// App on a CUSTOM domain — must NOT migrate.
	configJSON2 := `{"subdomain":"","domain":"myapp.custom.com","http_port":3004}`
	_, err = db.Exec(`INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
		"app2", "Custom", "repo", "custom", "/path2", "running", "healthy", configJSON2)
	if err != nil {
		t.Fatalf("insert app2: %v", err)
	}

	m := &Manager{db: db, logger: slog.Default()}
	var unregistered, registered []string
	m.routeUnregistrar = func(hostname string) error { unregistered = append(unregistered, hostname); return nil }
	m.routeRegistrar = func(hostname string) error { registered = append(registered, hostname); return nil }

	if err := m.MigrateAppDomains(context.Background(), "test.local", "new.local"); err != nil {
		t.Fatalf("MigrateAppDomains: %v", err)
	}

	// Old hostname unregistered, new hostname registered for the migrated app.
	if len(unregistered) != 1 || unregistered[0] != "convertx.test.local" {
		t.Errorf("expected unregister convertx.test.local, got %v", unregistered)
	}
	if len(registered) != 1 || registered[0] != "convertx.new.local" {
		t.Errorf("expected register convertx.new.local, got %v", registered)
	}

	// DB metadata rewritten for the migrated app, untouched for the custom one.
	var meta string
	if err := db.QueryRow(`SELECT metadata FROM apps WHERE id = 'app1'`).Scan(&meta); err != nil {
		t.Fatalf("query app1 metadata: %v", err)
	}
	if !strings.Contains(meta, `"domain":"new.local"`) {
		t.Errorf("expected app1 metadata to contain new.local, got %s", meta)
	}
	if strings.Contains(meta, "test.local") {
		t.Errorf("expected app1 metadata to drop test.local, got %s", meta)
	}
	if err := db.QueryRow(`SELECT metadata FROM apps WHERE id = 'app2'`).Scan(&meta); err != nil {
		t.Fatalf("query app2 metadata: %v", err)
	}
	if !strings.Contains(meta, "myapp.custom.com") {
		t.Errorf("expected app2 custom domain untouched, got %s", meta)
	}
}

// TestMigrateAppDomainsNoop covers the guard: same-domain or empty-domain
// calls must not touch anything.
func TestMigrateAppDomainsNoop(t *testing.T) {
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	_ = db.Migrate()

	m := &Manager{db: db, logger: slog.Default()}
	fired := false
	m.routeRegistrar = func(string) error { fired = true; return nil }
	m.routeUnregistrar = func(string) error { fired = true; return nil }

	_ = m.MigrateAppDomains(context.Background(), "test.local", "test.local") // same
	_ = m.MigrateAppDomains(context.Background(), "", "new.local")            // empty old
	_ = m.MigrateAppDomains(context.Background(), "test.local", "")           // empty new
	if fired {
		t.Error("expected no route callbacks for no-op migrations")
	}
}

// TestReconcileConnectDomains covers the startup heal: apps whose persisted
// domain is a stale Connect subdomain must be moved to the current default
// domain (both the routes table and app configs), while custom-domain apps
// stay put.
func TestReconcileConnectDomains(t *testing.T) {
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "test.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	defer db.Close()
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// App still on the OLD Connect subdomain — must be healed.
	_, err = db.Exec(`INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
		"app1", "ConvertX", "repo", "convertx", "/path1", "running", "healthy",
		`{"subdomain":"convertx","domain":"3a2b01ec.free.servers.libreloom.org","http_port":3002}`)
	if err != nil {
		t.Fatalf("insert app1: %v", err)
	}
	// App already on the CURRENT domain — must be untouched.
	_, err = db.Exec(`INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
		"app2", "Nextcloud", "repo", "nextcloud", "/path2", "running", "healthy",
		`{"subdomain":"nextcloud","domain":"plainskill.servers.libreloom.org","http_port":3003}`)
	if err != nil {
		t.Fatalf("insert app2: %v", err)
	}
	// Custom-domain app — must be untouched.
	_, err = db.Exec(`INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, ?)`,
		"app3", "Custom", "repo", "custom", "/path3", "running", "healthy",
		`{"subdomain":"","domain":"myapp.custom.com","http_port":3004}`)
	if err != nil {
		t.Fatalf("insert app3: %v", err)
	}
	// A route in the routes table still on the OLD Connect domain — must be
	// migrated even if the app config was already healed.
	_, err = db.Exec(`INSERT INTO routes (id, subdomain, domain, backend, app_id, ssl, enabled, restricted_access, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
		"route1", "convertx", "3a2b01ec.free.servers.libreloom.org", "http://localhost:3002", "app1", 0, 1, 0)
	if err != nil {
		t.Fatalf("insert route: %v", err)
	}

	// CaddyManager over the same DB so MigrateRoutes persists to the routes
	// table the reconcile queries.
	cm := network.NewCaddyManager(db, network.CaddyConfig{
		Mode:          "noop",
		ConfigPath:    filepath.Join(dir, "Caddyfile"),
		DefaultDomain: "plainskill.servers.libreloom.org",
	})
	ctx := context.Background()
	if err := cm.Initialize(ctx); err != nil {
		t.Fatalf("caddy initialize: %v", err)
	}

	m := &Manager{db: db, logger: slog.Default(), caddyManager: cm}
	var unregistered, registered []string
	m.routeUnregistrar = func(hostname string) error { unregistered = append(unregistered, hostname); return nil }
	m.routeRegistrar = func(hostname string) error { registered = append(registered, hostname); return nil }

	if err := m.ReconcileConnectDomains(ctx, "plainskill.servers.libreloom.org"); err != nil {
		t.Fatalf("ReconcileConnectDomains: %v", err)
	}

	// The stale route migrated to the new domain.
	if _, ok := cm.FindRouteByDomain("convertx.plainskill.servers.libreloom.org"); !ok {
		t.Error("expected route migrated to plainskill domain")
	}
	if _, ok := cm.FindRouteByDomain("convertx.3a2b01ec.free.servers.libreloom.org"); ok {
		t.Error("expected old-domain route to be gone")
	}

	// Only the stale app moved: old hostname dropped, new one registered.
	if len(unregistered) != 1 || unregistered[0] != "convertx.3a2b01ec.free.servers.libreloom.org" {
		t.Errorf("expected unregister of stale hostname, got %v", unregistered)
	}
	if len(registered) != 1 || registered[0] != "convertx.plainskill.servers.libreloom.org" {
		t.Errorf("expected register of new hostname, got %v", registered)
	}

	// DB metadata healed for app1, untouched for app2 and app3.
	var meta string
	if err := db.QueryRow(`SELECT metadata FROM apps WHERE id = 'app1'`).Scan(&meta); err != nil {
		t.Fatalf("query app1: %v", err)
	}
	if !strings.Contains(meta, `"domain":"plainskill.servers.libreloom.org"`) {
		t.Errorf("expected app1 healed to plainskill domain, got %s", meta)
	}
	if err := db.QueryRow(`SELECT metadata FROM apps WHERE id = 'app2'`).Scan(&meta); err != nil {
		t.Fatalf("query app2: %v", err)
	}
	if !strings.Contains(meta, `"domain":"plainskill.servers.libreloom.org"`) {
		t.Errorf("expected app2 unchanged on plainskill domain, got %s", meta)
	}
	if err := db.QueryRow(`SELECT metadata FROM apps WHERE id = 'app3'`).Scan(&meta); err != nil {
		t.Fatalf("query app3: %v", err)
	}
	if !strings.Contains(meta, "myapp.custom.com") {
		t.Errorf("expected app3 custom domain untouched, got %s", meta)
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

func TestManager_GetRepoStatus_Nil(t *testing.T) {
	m := &Manager{}
	statuses := m.GetRepoStatus()
	if statuses != nil {
		t.Fatalf("expected nil when no repoSet, got %+v", statuses)
	}
}

func TestManager_ForcePullRepos_NoRepoSet(t *testing.T) {
	m := &Manager{}
	err := m.ForcePullRepos(context.Background())
	if err == nil {
		t.Fatal("expected error when no repoSet configured")
	}
}

func TestManager_TriggerRepoPull_NoRepoSet(t *testing.T) {
	m := &Manager{}
	m.TriggerRepoPull(context.Background())
}

func TestManager_maybeSetPublicURL(t *testing.T) {
	dbDir := t.TempDir()
	dbPath := filepath.Join(dbDir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	configPath := filepath.Join(t.TempDir(), "Caddyfile")
	cfg := network.CaddyConfig{
		Mode:          "noop",
		AdminAPI:      "",
		ConfigPath:    configPath,
		DefaultDomain: "example.com",
		AutoHTTPS:     true,
	}
	cm := network.NewCaddyManager(db, cfg)
	if err := cm.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize caddy manager: %v", err)
	}

	ctx := context.Background()
	if _, err := cm.AddRoute(ctx, "app", "example.com", "http://localhost:8888", "inst1"); err != nil {
		t.Fatalf("add route: %v", err)
	}

	m := &Manager{db: db, caddyManager: cm}
	app := &InstalledApp{ID: "inst1", URL: "http://localhost:8888"}
	m.maybeSetPublicURL(app)
	if app.URL != "https://app.example.com" {
		t.Fatalf("expected public https URL, got %s", app.URL)
	}

	app2 := &InstalledApp{ID: "no-route", URL: "http://localhost:8888"}
	m.maybeSetPublicURL(app2)
	if app2.URL != "http://localhost:8888" {
		t.Fatalf("expected original localhost URL when no route, got %s", app2.URL)
	}

	// Disabled proxy should leave URL untouched.
	cmDisabled := network.NewCaddyManager(db, network.CaddyConfig{Mode: "disabled", ConfigPath: configPath})
	m2 := &Manager{db: db, caddyManager: cmDisabled}
	app3 := &InstalledApp{ID: "inst1", URL: "http://localhost:8888"}
	m2.maybeSetPublicURL(app3)
	if app3.URL != "http://localhost:8888" {
		t.Fatalf("expected original URL when proxy disabled, got %s", app3.URL)
	}
}

func TestManager_EnsurePublicURL(t *testing.T) {
	// EnsurePublicURL is the exported wrapper the install handler calls so the
	// install response carries the correct public URL (https when AutoHTTPS).
	dbDir := t.TempDir()
	dbPath := filepath.Join(dbDir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	configPath := filepath.Join(t.TempDir(), "Caddyfile")
	cm := network.NewCaddyManager(db, network.CaddyConfig{
		Mode:          "noop",
		ConfigPath:    configPath,
		DefaultDomain: "example.com",
		AutoHTTPS:     true,
	})
	if err := cm.Initialize(context.Background()); err != nil {
		t.Fatalf("initialize caddy manager: %v", err)
	}
	ctx := context.Background()
	if _, err := cm.AddRoute(ctx, "app", "example.com", "http://localhost:8888", "inst1"); err != nil {
		t.Fatalf("add route: %v", err)
	}
	m := &Manager{db: db, caddyManager: cm}
	app := &InstalledApp{ID: "inst1", URL: "http://localhost:8888"}
	m.EnsurePublicURL(app)
	if app.URL != "https://app.example.com" {
		t.Fatalf("EnsurePublicURL: expected https public URL, got %s", app.URL)
	}

	// Nil app must not panic (the install handler calls it unconditionally).
	m.EnsurePublicURL(nil)
}

func TestManager_PinUnpinAppVersion(t *testing.T) {
	dbDir := t.TempDir()
	dbPath := filepath.Join(dbDir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	_, err = db.Exec(`INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, pinned_version) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '{}', '')`,
		"inst-pin", "App", "repo", "app1", "/path", "running", "healthy")
	if err != nil {
		t.Fatalf("insert app: %v", err)
	}

	m := &Manager{db: db, logger: slog.Default()}
	ctx := context.Background()

	if err := m.PinAppVersion(ctx, "inst-pin", "2.0.0"); err != nil {
		t.Fatalf("PinAppVersion: %v", err)
	}

	var pinned sql.NullString
	if err := db.QueryRow(`SELECT pinned_version FROM apps WHERE id = ?`, "inst-pin").Scan(&pinned); err != nil {
		t.Fatalf("query pinned version: %v", err)
	}
	if pinned.String != "2.0.0" || !pinned.Valid {
		t.Fatalf("expected pinned version 2.0.0, got %v", pinned)
	}

	if err := m.UnpinAppVersion(ctx, "inst-pin"); err != nil {
		t.Fatalf("UnpinAppVersion: %v", err)
	}
	if err := db.QueryRow(`SELECT pinned_version FROM apps WHERE id = ?`, "inst-pin").Scan(&pinned); err != nil {
		t.Fatalf("query pinned version after unpin: %v", err)
	}
	if pinned.Valid {
		t.Fatalf("expected null pinned version after unpin, got %v", pinned)
	}
}

func TestManager_AcknowledgeRevocation(t *testing.T) {
	dbDir := t.TempDir()
	dbPath := filepath.Join(dbDir, "test.db")
	db, err := database.Open(dbPath)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	_, err = db.Exec(`INSERT INTO apps (id, name, type, source, path, status, health_status, installed_at, updated_at, metadata, revocation_severity, revocation_reason, revocation_revoked_at, revocation_acknowledged_at) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, '{}', ?, ?, CURRENT_TIMESTAMP, NULL)`,
		"inst-rev", "App", "repo", "app1", "/path", "revoked", "unknown", "critical", "bad-version")
	if err != nil {
		t.Fatalf("insert app: %v", err)
	}

	m := &Manager{db: db, logger: slog.Default()}
	ctx := context.Background()
	if err := m.AcknowledgeRevocation(ctx, "inst-rev"); err != nil {
		t.Fatalf("AcknowledgeRevocation: %v", err)
	}

	var ackedAt *time.Time
	if err := db.QueryRow(`SELECT revocation_acknowledged_at FROM apps WHERE id = ?`, "inst-rev").Scan(&ackedAt); err != nil {
		t.Fatalf("query acked_at: %v", err)
	}
	if ackedAt == nil || ackedAt.IsZero() {
		t.Fatal("expected revocation_acknowledged_at to be set")
	}

	// Acknowledging again should fail because there is no unacknowledged revocation.
	if err := m.AcknowledgeRevocation(ctx, "inst-rev"); err == nil {
		t.Fatal("expected error on second acknowledgement")
	}
}
