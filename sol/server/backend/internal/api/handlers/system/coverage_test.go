package system

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers/shared"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/handlers/testutil"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/audit"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/security"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/settings"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/setup"
)

func TestMonitoringHandlersCoverage(t *testing.T) {
	h := newTestMonitoringHandlers(t)

	tracker := NewFailureTracker()
	if tracker.RecordFailure("database") != 1 || tracker.RecordFailure("database") != 2 {
		t.Fatal("failure tracker did not increment")
	}
	if !tracker.CanAlert("database") {
		t.Fatal("new failure should be alertable")
	}
	tracker.RecordAlert("database")
	if tracker.CanAlert("database") {
		t.Fatal("recent alert should be throttled")
	}
	tracker.RecordSuccess("database")

	cache := NewHealthCheckCache(time.Hour)
	if cache.Get() != nil || !cache.ShouldRefresh() {
		t.Fatal("empty cache should require refresh")
	}
	cachedResult := &ComprehensiveHealthResponse{Status: "healthy", OverallPass: true}
	cache.Set(cachedResult)
	if cache.Get() != cachedResult || cache.ShouldRefresh() {
		t.Fatal("fresh cache was not returned")
	}

	for _, tc := range []struct {
		name, method, target, body string
		params                     map[string]string
		fn                         http.HandlerFunc
		want                       int
	}{
		{"health missing", http.MethodGet, "/apps/x/health", "", nil, h.GetAppHealth, 400},
		{"health", http.MethodGet, "/apps/x/health", "", map[string]string{"appID": "unknown"}, h.GetAppHealth, 200},
		{"metrics missing", http.MethodGet, "/apps/x/metrics", "", nil, h.GetAppMetrics, 400},
		{"metrics cached", http.MethodGet, "/apps/x/metrics", "", map[string]string{"appID": "unknown"}, h.GetAppMetrics, 200},
		{"history missing", http.MethodGet, "/apps/x/metrics/history", "", nil, h.GetMetricsHistory, 400},
		{"history", http.MethodGet, "/apps/x/metrics/history?since=bad&limit=9999", "", map[string]string{"appID": "unknown"}, h.GetMetricsHistory, 200},
		{"register missing", http.MethodPost, "/apps/x/health", `{}`, nil, h.RegisterHealthCheck, 400},
		{"register bad", http.MethodPost, "/apps/x/health", `{`, map[string]string{"appID": "unknown"}, h.RegisterHealthCheck, 400},
		{"register", http.MethodPost, "/apps/x/health", `{"http":{"url":"http://127.0.0.1:1","method":"GET","expected_status":200},"interval_seconds":30,"timeout_seconds":1,"failure_threshold":2,"success_threshold":1}`, map[string]string{"appID": "unknown"}, h.RegisterHealthCheck, 200},
		{"unregister missing", http.MethodDelete, "/apps/x/health", "", nil, h.UnregisterHealthCheck, 400},
		{"unregister", http.MethodDelete, "/apps/x/health", "", map[string]string{"appID": "unknown"}, h.UnregisterHealthCheck, 200},
		{"system", http.MethodGet, "/monitoring/system", "", nil, h.SystemHealth, 200},
		{"cleanup default", http.MethodPost, "/monitoring/cleanup", "", nil, h.CleanupMetrics, 200},
		{"cleanup custom", http.MethodPost, "/monitoring/cleanup?retention_days=2", "", nil, h.CleanupMetrics, 200},
		{"email invalid", http.MethodPost, "/monitoring/email", `{}`, nil, h.SendTestEmail, 400},
		{"prometheus", http.MethodGet, "/metrics", "", nil, h.PrometheusMetrics, 200},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rec := testutil.CallHandler(t, tc.method, tc.target, tc.body, tc.params, tc.fn)
			if rec.Code != tc.want {
				t.Fatalf("got %d want %d: %s", rec.Code, tc.want, rec.Body.String())
			}
		})
	}

	for _, method := range []string{http.MethodGet, http.MethodPost} {
		rec := testutil.CallHandler(t, method, "/health/check", "", nil, h.ComprehensiveHealthCheck)
		if rec.Code != http.StatusServiceUnavailable {
			t.Fatalf("comprehensive %s: %d %s", method, rec.Code, rec.Body.String())
		}
	}

	for _, value := range []uint64{1, 1024, 1024 * 1024, 5 * 1024 * 1024 * 1024} {
		if formatBytes(value) == "" {
			t.Fatal("formatBytes returned empty")
		}
	}
	if ok, _, _ := checkPathWritableHealth(t.TempDir(), config.Get()); !ok {
		t.Fatal("temporary directory should be writable")
	}
	if ok, _, _ := checkPathWritableHealth(filepath.Join(t.TempDir(), "new"), config.Get()); !ok {
		t.Fatal("new temporary directory should be writable")
	}

	failed := &ComprehensiveHealthResponse{
		Status:      "unhealthy",
		OverallPass: false,
		Checks: map[string]*HealthCheckResult{
			"runtime":  {Status: "failed"},
			"database": {Status: "passed"},
		},
	}
	h.trackFailuresAndAlert(failed)
	h.trackFailuresAndAlert(failed)
	h.trackFailuresAndAlert(failed)

	h.mailer = nil
	rec := testutil.CallHandler(t, http.MethodPost, "/monitoring/email", `{"to":"person@example.test"}`, nil, h.SendTestEmail)
	if rec.Code != 500 {
		t.Fatalf("nil mailer: %d", rec.Code)
	}
}

func TestSettingsAndSecurityHandlersCoverage(t *testing.T) {
	f := testutil.NewFixture(t)
	settingsService := settings.NewService(f.DB.SQL())
	securityService := security.NewService(f.DB, slog.New(slog.NewTextHandler(io.Discard, nil)), security.NewEmailNotifier())
	t.Cleanup(securityService.Close)
	authService := auth.NewService(f.DB, "coverage-settings-secret", slog.Default())
	user, err := authService.Register(context.Background(), &auth.RegisterRequest{
		Username: "settings-user",
		Password: "SettingsPassword123",
		Email:    "settings@example.test",
	})
	if err != nil {
		t.Fatal(err)
	}

	h := NewSettingsHandler(settingsService, securityService)
	userRequest := func(method, target, body, role string) *http.Request {
		req := httptest.NewRequest(method, target, strings.NewReader(body))
		return testutil.RequestWithUser(req, user.ID, user.Username, role)
	}
	call := func(req *http.Request, fn http.HandlerFunc) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		fn(rec, req)
		return rec
	}

	for _, fn := range []http.HandlerFunc{h.Get, h.GetProxy, h.GetNotifications, h.GetAISupport} {
		rec := call(httptest.NewRequest(http.MethodGet, "/", nil), fn)
		if rec.Code != 200 {
			t.Fatalf("settings get: %d %s", rec.Code, rec.Body.String())
		}
	}
	for _, body := range []string{"{", `{"logging":{"level":"debug"}}`} {
		rec := call(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(body)), h.Update)
		want := 200
		if body == "{" {
			want = 400
		}
		if rec.Code != want {
			t.Fatalf("settings update %q: %d %s", body, rec.Code, rec.Body.String())
		}
	}
	nilSettings := NewSettingsHandler(nil, securityService)
	rec := call(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{}`)), nilSettings.Update)
	if rec.Code != 500 {
		t.Fatalf("nil settings update: %d", rec.Code)
	}

	rec = call(httptest.NewRequest(http.MethodGet, "/", nil), h.GetSecurity)
	if rec.Code != 401 {
		t.Fatalf("security unauthenticated: %d", rec.Code)
	}
	rec = call(userRequest(http.MethodGet, "/", "", "user"), h.GetSecurity)
	if rec.Code != 200 {
		t.Fatalf("get security: %d %s", rec.Code, rec.Body.String())
	}
	for _, body := range []string{"{", `{"notification_frequency":"never"}`, `{"notification_frequency":"instant","notifications_enabled":true}`} {
		rec = call(userRequest(http.MethodPut, "/", body, "user"), h.UpdateSecurity)
		want := 200
		if body != `{"notification_frequency":"instant","notifications_enabled":true}` {
			want = 400
		}
		if rec.Code != want {
			t.Fatalf("update security %q: %d %s", body, rec.Code, rec.Body.String())
		}
	}

	for _, body := range []string{"{", `{}`, `{"notify":{"enabled":false}}`} {
		rec = call(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(body)), h.UpdateNotifications)
		want := 200
		if body == "{" || body == `{}` {
			want = 400
		}
		if rec.Code != want {
			t.Fatalf("update notifications %q: %d %s", body, rec.Code, rec.Body.String())
		}
	}
	for _, body := range []string{`{}`, `{"template":"Hello {{.Name}}","data":{"Name":"Ada"}}`} {
		rec = call(httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body)), h.PreviewTemplate)
		want := 200
		if body == `{}` {
			want = 400
		}
		if rec.Code != want {
			t.Fatalf("preview %q: %d %s", body, rec.Code, rec.Body.String())
		}
	}

	rec = call(httptest.NewRequest(http.MethodPost, "/", nil), h.TestNotification)
	if rec.Code != 401 {
		t.Fatalf("test notification unauthenticated: %d", rec.Code)
	}
	rec = call(userRequest(http.MethodPost, "/", "", "user"), h.TestNotification)
	if rec.Code != 200 {
		t.Fatalf("test notification: %d %s", rec.Code, rec.Body.String())
	}
	rec = call(userRequest(http.MethodPost, "/", "", "user"), h.TestNotification)
	if rec.Code != 429 {
		t.Fatalf("test notification rate limit: %d", rec.Code)
	}

	for _, body := range []string{
		"{",
		`{"default_domain":"invalid"}`,
		`{"ssl_email":"invalid"}`,
		`{"mode":"wrong"}`,
		`{"auto_https":"yes"}`,
		`{"mode":"noop","default_domain":"valid.example.test","ssl_email":"a@example.test","auto_https":true}`,
	} {
		rec = call(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(body)), h.UpdateProxy)
		want := 400
		if strings.Contains(body, `"mode":"noop"`) {
			want = 200
		}
		if rec.Code != want {
			t.Fatalf("proxy %q: %d %s", body, rec.Code, rec.Body.String())
		}
	}
	for _, value := range []string{"", "-bad.test", ".bad.test", "bad space.test", "nodot", "valid.example"} {
		_ = shared.ValidateDomain(value)
	}
	for _, value := range []string{"", "missing", "@example.test", "a@", "a@@example.test", "a@example", "a@example.test"} {
		_ = shared.ValidateEmail(value)
	}

	h.SetModelSource(func(context.Context) ([]agent.ModelInfo, error) {
		return []agent.ModelInfo{{ID: "model-one"}}, nil
	})
	rec = call(httptest.NewRequest(http.MethodGet, "/", nil), h.GetAISupport)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "model-one") {
		t.Fatalf("AI settings models: %d %s", rec.Code, rec.Body.String())
	}
	rec = call(httptest.NewRequest(http.MethodPut, "/", strings.NewReader(`{}`)), h.UpdateAISupport)
	if rec.Code != 403 {
		t.Fatalf("AI update unauthenticated: %d", rec.Code)
	}
	rec = call(userRequest(http.MethodPut, "/", "{", "admin"), h.UpdateAISupport)
	if rec.Code != 400 {
		t.Fatalf("AI update bad json: %d", rec.Code)
	}
	rec = call(userRequest(http.MethodPut, "/", `{"enabled":true,"main_model":"model-one"}`, "admin"), h.UpdateAISupport)
	if rec.Code != 200 {
		t.Fatalf("AI update: %d %s", rec.Code, rec.Body.String())
	}

	modelServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"data":[{"id":"remote-model"}]}`)
	}))
	defer modelServer.Close()
	rec = call(userRequest(http.MethodPost, "/", fmt.Sprintf(`{"base_url":%q,"api_key":"key"}`, modelServer.URL), "admin"), h.FetchModels)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "remote-model") {
		t.Fatalf("fetch models: %d %s", rec.Code, rec.Body.String())
	}

	securityHandler := NewSecurityHandler(securityService)
	for _, target := range []string{"/events?limit=0", "/events?offset=-1", "/events?since=bad", "/events?type=bad", "/events?severity=bad"} {
		rec = call(httptest.NewRequest(http.MethodGet, target, nil), securityHandler.ListEvents)
		if rec.Code != 400 {
			t.Fatalf("security validation %s: %d", target, rec.Code)
		}
	}
	rec = call(userRequest(http.MethodGet, "/events?limit=10&type=login_success&severity=info&since=2020-01-01T00:00:00Z", "", "user"), securityHandler.ListEvents)
	if rec.Code != 200 {
		t.Fatalf("security list: %d %s", rec.Code, rec.Body.String())
	}
	rec = call(userRequest(http.MethodGet, "/stats", "", "user"), securityHandler.GetStats)
	if rec.Code != 403 {
		t.Fatalf("security stats user: %d", rec.Code)
	}
	rec = call(userRequest(http.MethodGet, "/stats", "", "admin"), securityHandler.GetStats)
	if rec.Code != 200 {
		t.Fatalf("security stats admin: %d %s", rec.Code, rec.Body.String())
	}
	rec = call(httptest.NewRequest(http.MethodGet, "/health", nil), securityHandler.GetHealth)
	if rec.Code != 200 {
		t.Fatalf("security health: %d", rec.Code)
	}
	for _, remote := range []string{"not-an-ip", "127.0.0.1:1234"} {
		req := httptest.NewRequest(http.MethodGet, "/", nil)
		req.RemoteAddr = remote
		req.Header.Set("X-Forwarded-For", "198.51.100.2")
		if shared.GetClientIP(req) == "" {
			t.Fatal("client IP should not be empty")
		}
	}
}

func TestFactoryResetAndAuditCoverage(t *testing.T) {
	f := testutil.NewFixture(t)
	authService := auth.NewService(f.DB, "coverage-reset-secret", slog.Default())
	user, err := authService.Register(context.Background(), &auth.RegisterRequest{
		Username: "reset-user",
		Password: "ResetPassword123",
		Email:    "reset@example.test",
	})
	if err != nil {
		t.Fatal(err)
	}
	reset := NewFactoryResetHandler(f.DB, setup.NewService(f.DB), authService)
	for _, body := range []string{"{", `{}`, `{"confirm":true}`, `{"confirm":true,"password":"wrong"}`} {
		req := httptest.NewRequest(http.MethodPost, "/reset", strings.NewReader(body))
		if strings.Contains(body, `"password"`) {
			req = testutil.RequestWithUser(req, user.ID, user.Username, "admin")
		}
		rec := httptest.NewRecorder()
		reset.FactoryReset(rec, req)
		if rec.Code < 400 {
			t.Fatalf("reset validation %q: %d", body, rec.Code)
		}
	}
	req := testutil.RequestWithUser(
		httptest.NewRequest(http.MethodPost, "/reset", strings.NewReader(`{"confirm":true,"password":"ResetPassword123"}`)),
		user.ID, user.Username, "admin",
	)
	rec := httptest.NewRecorder()
	reset.FactoryReset(rec, req)
	if rec.Code != 200 {
		t.Fatalf("factory reset: %d %s", rec.Code, rec.Body.String())
	}

	auditHandler := NewAuditHandler(audit.NewService(f.DB))
	rec = testutil.CallHandler(t, http.MethodGet, "/audit?limit=bad", "", nil, auditHandler.ListLogs)
	if rec.Code != 200 {
		t.Fatalf("audit list: %d %s", rec.Code, rec.Body.String())
	}
}
