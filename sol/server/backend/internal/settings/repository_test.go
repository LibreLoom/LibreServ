package settings

import (
	"context"
	"database/sql"
	"path/filepath"
	"reflect"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func newTestDB(t *testing.T) *sql.DB {
	t.Helper()
	db, err := database.Open(filepath.Join(t.TempDir(), "settings.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	if err := db.Migrate(); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db.SQL()
}

// useTestConfig installs a config with a temp log path so logger.Init calls in
// the code under test never touch a real log file.
func useTestConfig(t *testing.T, cfg *config.Config) *config.Config {
	t.Helper()
	if cfg.Logging.Path == "" {
		cfg.Logging.Path = filepath.Join(t.TempDir(), "libreserv.log")
	}
	orig := config.Get()
	config.SetTestConfig(cfg)
	t.Cleanup(func() { config.SetTestConfig(orig) })
	return cfg
}

func TestRepository_GetSetDelete(t *testing.T) {
	repo := NewRepository(newTestDB(t))

	got, err := repo.Get("missing.key")
	if err != nil {
		t.Fatalf("Get on missing key: %v", err)
	}
	if got != "" {
		t.Errorf("Get on missing key = %q, want empty string", got)
	}

	if err := repo.Set("smtp.host", "mail.example.com", "string"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if got, _ := repo.Get("smtp.host"); got != "mail.example.com" {
		t.Errorf("Get = %q, want mail.example.com", got)
	}

	// Set upserts rather than failing on the primary key.
	if err := repo.Set("smtp.host", "relay.example.com", "string"); err != nil {
		t.Fatalf("Set (upsert): %v", err)
	}
	if got, _ := repo.Get("smtp.host"); got != "relay.example.com" {
		t.Errorf("Get after upsert = %q, want relay.example.com", got)
	}

	if err := repo.Delete("smtp.host"); err != nil {
		t.Fatalf("Delete: %v", err)
	}
	if got, _ := repo.Get("smtp.host"); got != "" {
		t.Errorf("Get after delete = %q, want empty string", got)
	}

	// Deleting a missing key is not an error.
	if err := repo.Delete("smtp.host"); err != nil {
		t.Errorf("Delete on missing key: %v", err)
	}
}

func TestRepository_SetTx(t *testing.T) {
	db := newTestDB(t)
	repo := NewRepository(db)

	tx, err := db.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if err := repo.SetTx(tx, "notify.enabled", "true", "bool"); err != nil {
		t.Fatalf("SetTx: %v", err)
	}
	if err := tx.Rollback(); err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if got, _ := repo.Get("notify.enabled"); got != "" {
		t.Errorf("Get after rollback = %q, want empty string", got)
	}

	tx, err = db.Begin()
	if err != nil {
		t.Fatalf("begin: %v", err)
	}
	if err := repo.SetTx(tx, "notify.enabled", "true", "bool"); err != nil {
		t.Fatalf("SetTx: %v", err)
	}
	if err := tx.Commit(); err != nil {
		t.Fatalf("commit: %v", err)
	}
	if got, _ := repo.Get("notify.enabled"); got != "true" {
		t.Errorf("Get after commit = %q, want true", got)
	}
}

func TestRepository_GetAllAndListAndIsEmpty(t *testing.T) {
	repo := NewRepository(newTestDB(t))

	empty, err := repo.IsEmpty()
	if err != nil {
		t.Fatalf("IsEmpty: %v", err)
	}
	if !empty {
		t.Fatal("IsEmpty = false on a fresh database")
	}

	if err := repo.Set("b.key", "2", "int"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	if err := repo.Set("a.key", "1", "string"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	all, err := repo.GetAll()
	if err != nil {
		t.Fatalf("GetAll: %v", err)
	}
	if want := map[string]string{"a.key": "1", "b.key": "2"}; !reflect.DeepEqual(all, want) {
		t.Errorf("GetAll = %v, want %v", all, want)
	}

	list, err := repo.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("List = %d settings, want 2", len(list))
	}
	if list[0].Key != "a.key" || list[1].Key != "b.key" {
		t.Errorf("List keys = %q, %q, want them ordered by key", list[0].Key, list[1].Key)
	}
	if list[1].Type != "int" {
		t.Errorf("List[1].Type = %q, want int", list[1].Type)
	}
	if list[0].UpdatedAt.IsZero() {
		t.Error("List[0].UpdatedAt is zero, want the write timestamp")
	}

	if empty, err = repo.IsEmpty(); err != nil || empty {
		t.Errorf("IsEmpty = %v (err %v), want false", empty, err)
	}
}

func TestRepository_SeedFromConfig(t *testing.T) {
	repo := NewRepository(newTestDB(t))

	if err := repo.Set("smtp.host", "already-set.example.com", "string"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	cfg := useTestConfig(t, &config.Config{})
	cfg.Logging.Level = "debug"
	cfg.SMTP.Host = "from-config.example.com"
	cfg.SMTP.Port = 2525
	cfg.SMTP.UseTLS = true
	cfg.Notify.Enabled = true
	cfg.Notify.SupportRecipients = []string{"a@example.com", "b@example.com"}
	cfg.CORS.AllowedOrigins = []string{"https://one.example.com", "https://two.example.com"}
	cfg.Support.Agent.MaxTurns = 7
	cfg.Support.Agent.TurnTimeout = 90 * time.Second
	cfg.Connect.ServiceStates = map[string]string{"llm": "connected", "blank": ""}

	if err := repo.SeedFromConfig(); err != nil {
		t.Fatalf("SeedFromConfig: %v", err)
	}

	all, err := repo.GetAll()
	if err != nil {
		t.Fatalf("GetAll: %v", err)
	}
	checks := map[string]string{
		"smtp.host":                  "already-set.example.com", // pre-existing values are never overwritten
		"logging.level":              "debug",
		"smtp.port":                  "2525",
		"smtp.use_tls":               "true",
		"notify.enabled":             "true",
		"notify.support_recipients":  "a@example.com,b@example.com",
		"cors.allowed_origins":       "https://one.example.com,https://two.example.com",
		"support.agent.max_turns":    "7",
		"support.agent.turn_timeout": "1m30s",
		"connect.services.llm.state": "connected",
	}
	for key, want := range checks {
		if all[key] != want {
			t.Errorf("setting %q = %q, want %q", key, all[key], want)
		}
	}
	if _, ok := all["connect.services.blank.state"]; ok {
		t.Error("blank connect service state was persisted, want it skipped")
	}

	var portType string
	if err := repo.db.QueryRow(`SELECT type FROM app_settings WHERE key = 'smtp.port'`).Scan(&portType); err != nil {
		t.Fatalf("query smtp.port type: %v", err)
	}
	if portType != "int" {
		t.Errorf("smtp.port type = %q, want int", portType)
	}
}

func TestRepository_SeedFromConfig_NoConfig(t *testing.T) {
	repo := NewRepository(newTestDB(t))
	orig := config.Get()
	config.SetTestConfig(nil)
	t.Cleanup(func() { config.SetTestConfig(orig) })

	if err := repo.SeedFromConfig(); err == nil {
		t.Fatal("SeedFromConfig with no config = nil error, want an error")
	}
	if err := repo.LoadIntoConfig(); err == nil {
		t.Fatal("LoadIntoConfig with no config = nil error, want an error")
	}
}

func TestRepository_LoadIntoConfig(t *testing.T) {
	repo := NewRepository(newTestDB(t))
	stored := map[string]string{
		"logging.level":                 "warn",
		"smtp.host":                     "db.example.com",
		"smtp.port":                     "2525",
		"smtp.use_tls":                  "true",
		"notify.enabled":                "true",
		"notify.support_recipients":     `a@example.com,"quoted,name"@example.com`,
		"cors.allowed_origins":          "https://one.example.com",
		"network.caddy.mode":            "enabled",
		"network.tunnel.provider":       "cloudflare",
		"network.tunnel.enabled":        "true",
		"updates.owner":                 "LibreLoom",
		"support.agent.max_turns":       "9",
		"support.agent.turn_timeout":    "2m",
		"support.self_healing":          "true",
		"connect.services.llm.state":    "byo",
		"connect.services..state":       "ignored",
		"connect.services.other.state":  "",
		"support.agent.review_enabled":  "true",
		"support.agent.system_prompt":   "be nice",
		"support.agent.main_model":      "main",
		"support.agent.review_model":    "review",
		"support.byok_enabled":          "true",
		"support.user_api_format":       "openai",
		"network.caddy.auto_https":      "true",
		"network.caddy.default_domain":  "example.com",
		"network.caddy.email":           "ops@example.com",
		"notify.welcome_subject":        "welcome",
		"notify.welcome_body":           "hello",
		"notify.support_subject":        "support",
		"notify.support_body":           "help",
		"server.mode":                   "release",
		"smtp.username":                 "user",
		"smtp.password":                 "pass",
		"smtp.from":                     "no-reply@example.com",
		"smtp.skip_verify":              "false",
		"updates.base_url":              "https://updates.example.com",
		"updates.repo":                  "LibreServ",
		"support.inference_base_url":    "https://inference.example.com",
		"support.user_base_url":         "https://user.example.com",
		"support.user_api_key":          "sk-test",
		"unknown.key.that.is.not.bound": "ignored",
	}
	for key, value := range stored {
		if err := repo.Set(key, value, typeFor(key)); err != nil {
			t.Fatalf("Set %s: %v", key, err)
		}
	}

	// Invalid numeric values must leave the existing config value untouched.
	if err := repo.Set("smtp.port", "not-a-number", "int"); err != nil {
		t.Fatalf("Set: %v", err)
	}

	cfg := useTestConfig(t, &config.Config{})
	cfg.SMTP.Port = 587
	cfg.Server.Mode = "debug"

	if err := repo.LoadIntoConfig(); err != nil {
		t.Fatalf("LoadIntoConfig: %v", err)
	}

	if cfg.Logging.Level != "warn" {
		t.Errorf("Logging.Level = %q, want warn", cfg.Logging.Level)
	}
	if cfg.SMTP.Host != "db.example.com" || !cfg.SMTP.UseTLS {
		t.Errorf("SMTP = %+v, want host db.example.com with TLS", cfg.SMTP)
	}
	if cfg.SMTP.Port != 587 {
		t.Errorf("SMTP.Port = %d, want the config value 587 kept when the stored value does not parse", cfg.SMTP.Port)
	}
	if !cfg.Notify.Enabled {
		t.Error("Notify.Enabled = false, want true")
	}
	if want := []string{"a@example.com", "quoted,name@example.com"}; !reflect.DeepEqual(cfg.Notify.SupportRecipients, want) {
		t.Errorf("Notify.SupportRecipients = %q, want %q", cfg.Notify.SupportRecipients, want)
	}
	if want := []string{"https://one.example.com"}; !reflect.DeepEqual(cfg.CORS.AllowedOrigins, want) {
		t.Errorf("CORS.AllowedOrigins = %q, want %q", cfg.CORS.AllowedOrigins, want)
	}
	if cfg.Server.Mode != "release" {
		t.Errorf("Server.Mode = %q, want release", cfg.Server.Mode)
	}
	if cfg.Network.Caddy.Mode != "enabled" || !cfg.Network.Caddy.AutoHTTPS {
		t.Errorf("Caddy = %+v, want mode enabled with auto HTTPS", cfg.Network.Caddy)
	}
	if cfg.Network.Tunnel.Provider != "cloudflare" || !cfg.Network.Tunnel.Enabled {
		t.Errorf("Tunnel = %+v, want cloudflare enabled", cfg.Network.Tunnel)
	}
	if cfg.Support.Agent.MaxTurns != 9 || cfg.Support.Agent.TurnTimeout != 2*time.Minute {
		t.Errorf("Agent = %+v, want 9 turns with a 2m timeout", cfg.Support.Agent)
	}
	if !cfg.Support.SelfHealing || !cfg.Support.BYOKEnabled {
		t.Errorf("Support flags = %+v, want self healing and BYOK enabled", cfg.Support)
	}
	if got := cfg.Connect.ServiceStates["llm"]; got != "byo" {
		t.Errorf("ServiceStates[llm] = %q, want byo", got)
	}
	if _, ok := cfg.Connect.ServiceStates["other"]; ok {
		t.Error("empty connect service state was applied, want it skipped")
	}
	if _, ok := cfg.Connect.ServiceStates[""]; ok {
		t.Error("connect service state with an empty ID was applied, want it skipped")
	}
}

func TestService_PersistTunnel(t *testing.T) {
	cfg := useTestConfig(t, &config.Config{})
	svc := NewService(newTestDB(t))

	if err := svc.PersistTunnel("cloudflare", "token-123", true); err != nil {
		t.Fatalf("PersistTunnel: %v", err)
	}

	all, err := svc.Repository().GetAll()
	if err != nil {
		t.Fatalf("GetAll: %v", err)
	}
	want := map[string]string{
		"network.tunnel.provider": "cloudflare",
		"network.tunnel.token":    "token-123",
		"network.tunnel.enabled":  "true",
	}
	for key, wantValue := range want {
		if all[key] != wantValue {
			t.Errorf("setting %q = %q, want %q", key, all[key], wantValue)
		}
	}
	if cfg.Network.Tunnel.Provider != "cloudflare" || cfg.Network.Tunnel.Token != "token-123" || !cfg.Network.Tunnel.Enabled {
		t.Errorf("in-memory tunnel config = %+v, want it mirrored", cfg.Network.Tunnel)
	}
}

func TestService_GetSettings(t *testing.T) {
	cfg := useTestConfig(t, &config.Config{})
	cfg.SMTP.Host = "mail.example.com"
	cfg.SMTP.Password = "secret"
	cfg.Support.UserAPIKey = "sk-secret"
	cfg.Network.Caddy.Mode = "enabled"
	cfg.Network.Caddy.AdminAPI = "http://localhost:2019"
	cfg.Network.Caddy.ConfigPath = "/etc/caddy/Caddyfile"
	cfg.Network.Caddy.DefaultDomain = "example.com"
	cfg.Network.Caddy.Email = "ops@example.com"

	svc := NewService(newTestDB(t))
	got, err := svc.GetSettings(context.Background())
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}

	smtp, ok := got["smtp"].(map[string]interface{})
	if !ok {
		t.Fatalf("smtp section = %T, want a map", got["smtp"])
	}
	if smtp["configured"] != true {
		t.Error("smtp.configured = false, want true when a password is set")
	}
	if _, leaked := smtp["password"]; leaked {
		t.Error("smtp section exposes the password")
	}

	ai, ok := got["ai_support"].(map[string]interface{})
	if !ok {
		t.Fatalf("ai_support section = %T, want a map", got["ai_support"])
	}
	if ai["user_key_configured"] != true {
		t.Error("ai_support.user_key_configured = false, want true when a key is set")
	}
	if _, leaked := ai["user_api_key"]; leaked {
		t.Error("ai_support section exposes the API key")
	}

	proxy, ok := got["proxy"].(map[string]interface{})
	if !ok {
		t.Fatalf("proxy section = %T, want a map", got["proxy"])
	}
	if proxy["type"] != "caddy" || proxy["mode"] != "enabled" || proxy["admin_api"] != "http://localhost:2019" {
		t.Errorf("proxy = %v, want the caddy details", proxy)
	}
}

func TestService_GetSettings_OmitsProxyWhenCaddyUnset(t *testing.T) {
	useTestConfig(t, &config.Config{})
	svc := NewService(newTestDB(t))

	got, err := svc.GetSettings(context.Background())
	if err != nil {
		t.Fatalf("GetSettings: %v", err)
	}
	if _, ok := got["proxy"]; ok {
		t.Error("proxy section present, want it omitted when caddy is unconfigured")
	}
}

func TestService_GetSettings_NoConfig(t *testing.T) {
	orig := config.Get()
	config.SetTestConfig(nil)
	t.Cleanup(func() { config.SetTestConfig(orig) })

	svc := NewService(newTestDB(t))
	if _, err := svc.GetSettings(context.Background()); err == nil {
		t.Fatal("GetSettings with no config = nil error, want an error")
	}
	if err := svc.UpdateSettings(context.Background(), map[string]interface{}{"logging": map[string]interface{}{}}); err == nil {
		t.Fatal("UpdateSettings with no config = nil error, want an error")
	}
}

func TestService_UpdateSettings_PersistsAppliesAndNotifies(t *testing.T) {
	cfg := useTestConfig(t, &config.Config{})
	cfg.Connect.ServiceStates = map[string]string{}
	svc := NewService(newTestDB(t))

	var changed []string
	svc.OnChange(func(keys []string) { changed = keys })

	updates := map[string]interface{}{
		"logging": map[string]interface{}{"level": "warn"},
		"smtp": map[string]interface{}{
			"host":     "mail.example.com",
			"port":     float64(2525), // JSON numbers decode as float64
			"username": "user",
			"password": "secret",
			"from":     "no-reply@example.com",
			"use_tls":  true,
		},
		"notify": map[string]interface{}{
			"enabled":            true,
			"support_recipients": []interface{}{"a@example.com", "b@example.com"},
			"support_subject":    "support",
		},
		"proxy": map[string]interface{}{
			"mode":           "enabled",
			"default_domain": "example.com",
			"ssl_email":      "ops@example.com",
			"auto_https":     true,
		},
		"updates": map[string]interface{}{"owner": "LibreLoom", "repo": "LibreServ"},
		"ai_support": map[string]interface{}{
			"byok_enabled":       true,
			"user_api_key":       "sk-test",
			"user_api_format":    "openai",
			"agent_max_turns":    float64(9),
			"agent_turn_timeout": "2m",
			"self_healing":       true,
			"main_model":         "main",
		},
		"connect_services": map[string]interface{}{"llm": "byo"},
	}
	if err := svc.UpdateSettings(context.Background(), updates); err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}

	if len(changed) == 0 {
		t.Fatal("OnChange callback received no changed keys")
	}

	if cfg.Logging.Level != "warn" {
		t.Errorf("Logging.Level = %q, want warn", cfg.Logging.Level)
	}
	if cfg.SMTP.Port != 2525 || cfg.SMTP.Host != "mail.example.com" || !cfg.SMTP.UseTLS {
		t.Errorf("SMTP = %+v, want the updated values", cfg.SMTP)
	}
	if want := []string{"a@example.com", "b@example.com"}; !reflect.DeepEqual(cfg.Notify.SupportRecipients, want) {
		t.Errorf("SupportRecipients = %q, want %q", cfg.Notify.SupportRecipients, want)
	}
	if cfg.Support.Agent.MaxTurns != 9 || cfg.Support.Agent.TurnTimeout != 2*time.Minute {
		t.Errorf("Agent = %+v, want 9 turns with a 2m timeout", cfg.Support.Agent)
	}
	if cfg.Connect.ServiceStates["llm"] != "byo" {
		t.Errorf("ServiceStates[llm] = %q, want byo", cfg.Connect.ServiceStates["llm"])
	}

	all, err := svc.Repository().GetAll()
	if err != nil {
		t.Fatalf("GetAll: %v", err)
	}
	for key, want := range map[string]string{
		"logging.level":              "warn",
		"smtp.port":                  "2525",
		"notify.support_recipients":  "a@example.com,b@example.com",
		"network.caddy.mode":         "enabled",
		"updates.owner":              "LibreLoom",
		"support.agent.max_turns":    "9",
		"connect.services.llm.state": "byo",
	} {
		if all[key] != want {
			t.Errorf("persisted %q = %q, want %q", key, all[key], want)
		}
	}
}

func TestService_UpdateSettings_Validation(t *testing.T) {
	tests := []struct {
		name    string
		updates map[string]interface{}
	}{
		{"unknown section only", map[string]interface{}{"nope": map[string]interface{}{"a": "b"}}},
		{"empty updates", map[string]interface{}{}},
		{"invalid logging format", map[string]interface{}{"logging": "not-a-map"}},
		{"invalid smtp format", map[string]interface{}{"smtp": "not-a-map"}},
		{"invalid notify format", map[string]interface{}{"notify": 1}},
		{"invalid proxy format", map[string]interface{}{"proxy": 1}},
		{"invalid updates format", map[string]interface{}{"updates": 1}},
		{"invalid ai_support format", map[string]interface{}{"ai_support": 1}},
		{"invalid connect_services format", map[string]interface{}{"connect_services": 1}},
		{"invalid logging level", map[string]interface{}{"logging": map[string]interface{}{"level": "verbose"}}},
		{"smtp port too high", map[string]interface{}{"smtp": map[string]interface{}{"port": float64(70000)}}},
		{"smtp port too low", map[string]interface{}{"smtp": map[string]interface{}{"port": float64(0)}}},
		{"skip_verify without insecure dev", map[string]interface{}{"smtp": map[string]interface{}{"skip_verify": true}}},
		{"invalid caddy mode", map[string]interface{}{"proxy": map[string]interface{}{"mode": "sometimes"}}},
		{"invalid connect service state", map[string]interface{}{"connect_services": map[string]interface{}{"llm": "maybe"}}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			cfg := useTestConfig(t, &config.Config{})
			cfg.Connect.ServiceStates = map[string]string{}
			svc := NewService(newTestDB(t))

			if err := svc.UpdateSettings(context.Background(), tc.updates); err == nil {
				t.Fatal("UpdateSettings = nil error, want a validation error")
			}

			all, err := svc.Repository().GetAll()
			if err != nil {
				t.Fatalf("GetAll: %v", err)
			}
			if len(all) != 0 {
				t.Errorf("persisted settings = %v, want nothing written on a rejected update", all)
			}
		})
	}
}

func TestService_UpdateSettings_SkipVerifyAllowedInInsecureDev(t *testing.T) {
	useTestConfig(t, &config.Config{})
	t.Setenv("LIBRESERV_INSECURE_DEV", "true")
	svc := NewService(newTestDB(t))

	updates := map[string]interface{}{"smtp": map[string]interface{}{"skip_verify": true}}
	if err := svc.UpdateSettings(context.Background(), updates); err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}
	if got, _ := svc.Repository().Get("smtp.skip_verify"); got != "true" {
		t.Errorf("smtp.skip_verify = %q, want true", got)
	}
}

func TestService_UpdateSettings_IgnoresOutOfRangeAIValues(t *testing.T) {
	cfg := useTestConfig(t, &config.Config{})
	cfg.Support.Agent.MaxTurns = 5
	cfg.Support.Agent.TurnTimeout = time.Minute
	svc := NewService(newTestDB(t))

	updates := map[string]interface{}{
		"ai_support": map[string]interface{}{
			"agent_max_turns":    float64(1000), // above the 100 cap
			"agent_turn_timeout": "10ms",        // below the 1s floor
			"user_api_format":    "cohere",      // unsupported format
			"user_api_key":       "",            // empty keys are ignored so the stored key survives
			"main_model":         "main",
		},
	}
	if err := svc.UpdateSettings(context.Background(), updates); err != nil {
		t.Fatalf("UpdateSettings: %v", err)
	}

	if cfg.Support.Agent.MaxTurns != 5 || cfg.Support.Agent.TurnTimeout != time.Minute {
		t.Errorf("Agent = %+v, want the out-of-range values ignored", cfg.Support.Agent)
	}
	if cfg.Support.UserAPIFormat != "" || cfg.Support.UserAPIKey != "" {
		t.Errorf("Support = %+v, want the rejected format and empty key ignored", cfg.Support)
	}
	all, err := svc.Repository().GetAll()
	if err != nil {
		t.Fatalf("GetAll: %v", err)
	}
	if want := map[string]string{"support.agent.main_model": "main"}; !reflect.DeepEqual(all, want) {
		t.Errorf("persisted = %v, want only %v", all, want)
	}
}

func TestTypeFor(t *testing.T) {
	tests := map[string]string{
		"smtp.port":                 "int",
		"support.agent.max_turns":   "int",
		"smtp.use_tls":              "bool",
		"notify.enabled":            "bool",
		"network.tunnel.enabled":    "bool",
		"notify.support_recipients": "csv",
		"cors.allowed_origins":      "csv",
		"updates.base_url":          "string",
		"anything.else":             "string",
	}
	for key, want := range tests {
		if got := typeFor(key); got != want {
			t.Errorf("typeFor(%q) = %q, want %q", key, got, want)
		}
	}
}

func TestCSVHelpers(t *testing.T) {
	if got := stringSliceToCSV(nil); got != "" {
		t.Errorf("stringSliceToCSV(nil) = %q, want empty", got)
	}
	if got := stringSliceToCSV([]string{"a", "b", "c"}); got != "a,b,c" {
		t.Errorf("stringSliceToCSV = %q, want a,b,c", got)
	}

	if got := csvToStringSlice(""); got != nil {
		t.Errorf("csvToStringSlice(\"\") = %v, want nil", got)
	}
	if got := csvToStringSlice(",,"); got != nil {
		t.Errorf("csvToStringSlice(\",,\") = %v, want nil (all entries empty)", got)
	}
	if want := []string{"a", "b"}; !reflect.DeepEqual(csvToStringSlice("a,,b"), want) {
		t.Errorf("csvToStringSlice(\"a,,b\") = %v, want %v", csvToStringSlice("a,,b"), want)
	}
	if want := []string{"a,b", "c"}; !reflect.DeepEqual(csvToStringSlice(`"a,b",c`), want) {
		t.Errorf("csvToStringSlice with quotes = %v, want %v", csvToStringSlice(`"a,b",c`), want)
	}
}

func TestToInt(t *testing.T) {
	tests := []struct {
		in     interface{}
		want   int
		wantOK bool
	}{
		{float64(42), 42, true},
		{7, 7, true},
		{"13", 13, true},
		{"nope", 0, false},
		{true, 0, false},
		{nil, 0, false},
	}
	for _, tc := range tests {
		got, ok := toInt(tc.in)
		if got != tc.want || ok != tc.wantOK {
			t.Errorf("toInt(%#v) = %v, %v; want %v, %v", tc.in, got, ok, tc.want, tc.wantOK)
		}
	}
}

func TestToBool(t *testing.T) {
	tests := []struct {
		in     interface{}
		want   bool
		wantOK bool
	}{
		{true, true, true},
		{"true", true, true},
		{"0", false, true},
		{"nope", false, false},
		{1, false, false},
		{nil, false, false},
	}
	for _, tc := range tests {
		got, ok := toBool(tc.in)
		if got != tc.want || ok != tc.wantOK {
			t.Errorf("toBool(%#v) = %v, %v; want %v, %v", tc.in, got, ok, tc.want, tc.wantOK)
		}
	}
}

func TestToStringSlice(t *testing.T) {
	if got, ok := toStringSlice([]string{"a"}); !ok || !reflect.DeepEqual(got, []string{"a"}) {
		t.Errorf("toStringSlice([]string) = %v, %v", got, ok)
	}
	if got, ok := toStringSlice([]interface{}{"a", 1, "b"}); !ok || !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Errorf("toStringSlice([]interface{}) = %v, %v; want non-strings skipped", got, ok)
	}
	if got, ok := toStringSlice("a,b"); !ok || !reflect.DeepEqual(got, []string{"a", "b"}) {
		t.Errorf("toStringSlice(csv) = %v, %v", got, ok)
	}
	if got, ok := toStringSlice(42); ok || got != nil {
		t.Errorf("toStringSlice(int) = %v, %v; want nil, false", got, ok)
	}
}
