package connect

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

func TestRealClientAPI(t *testing.T) {
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests = append(requests, r.Method+" "+r.URL.Path)
		if got := r.Header.Get("Authorization"); got != "Bearer test-connect-key" {
			t.Errorf("authorization = %q", got)
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/activate":
			var body ActivationRequest
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil || body.ConnectKey != "test-connect-key" {
				t.Errorf("activation body = %+v, %v", body, err)
			}
			_, _ = w.Write([]byte(`{"connected":true,"plan":{"id":"one","name":"Connect One"},"services":{}}`))
		case "/api/v1/deactivate":
			w.WriteHeader(http.StatusNoContent)
		case "/api/v1/services/provision":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["service"] != "smtp" {
				t.Errorf("provision body = %+v", body)
			}
			_, _ = w.Write([]byte(`{"smtp":{"host":"smtp.example.com","port":587,"username":"u","password":"p","from":"a@example.com","use_tls":true}}`))
		case "/api/v1/routes":
			var body map[string]string
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["hostname"] != "app.example.com" {
				t.Errorf("route body = %+v", body)
			}
			_, _ = w.Write([]byte(`{}`))
		case "/api/v1/tunnel/delete":
			_, _ = w.Write([]byte(`{}`))
		case "/api/v1/status":
			_, _ = w.Write([]byte(`{"connected":true,"services":{"smtp":{"state":"connected","label":"Email"}}}`))
		case "/api/v1/usage":
			_, _ = w.Write([]byte(`{"total_cost_usd":1.25,"remaining_usd":8.75}`))
		case "/api/v1/info":
			_, _ = w.Write([]byte(`{"plans":[{"id":"free","name":"Free","description":"Free","price_monthly":0}],"plan_limits":{"free":{"max_emails_per_day":30}}}`))
		case "/api/v1/verify-probe":
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			if body["host"] != "app.example.com" || body["port"] != float64(443) || body["protocol"] != "https" {
				t.Errorf("probe body = %+v", body)
			}
			_, _ = w.Write([]byte(`{"reachable":true,"latency_ms":42}`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewRealClient(Config{BaseURL: server.URL + "/", HTTPClient: server.Client()})
	if client.ConnectKey() != "" {
		t.Fatal("new client should not have a key")
	}
	status, err := client.Activate(context.Background(), "test-connect-key")
	if err != nil || !status.Connected || status.Plan.ID != PlanOne {
		t.Fatalf("activate = %+v, %v", status, err)
	}
	creds, err := client.Provision(context.Background(), ServiceSMTP)
	if err != nil || creds.SMTP == nil || creds.SMTP.Host != "smtp.example.com" {
		t.Fatalf("provision = %+v, %v", creds, err)
	}
	if err := client.RegisterRoute(context.Background(), "app.example.com"); err != nil {
		t.Fatalf("register route: %v", err)
	}
	if err := client.UnregisterRoute(context.Background(), "app.example.com"); err != nil {
		t.Fatalf("unregister route: %v", err)
	}
	if err := client.DeleteTunnel(context.Background()); err != nil {
		t.Fatalf("delete tunnel: %v", err)
	}
	status, err = client.Status(context.Background())
	if err != nil || status.Services[ServiceSMTP].State != ServiceConnected {
		t.Fatalf("status = %+v, %v", status, err)
	}
	usage, err := client.Usage(context.Background())
	if err != nil || usage.TotalCostUSD != 1.25 {
		t.Fatalf("usage = %+v, %v", usage, err)
	}
	info, err := client.Info(context.Background())
	if err != nil || len(info.Plans) != 1 || info.PlanLimits[PlanFree].MaxEmailsPerDay != 30 {
		t.Fatalf("info = %+v, %v", info, err)
	}
	probe, err := client.VerifyProbe(context.Background(), "app.example.com", 443, "https")
	if err != nil || !probe.Reachable || probe.LatencyMS != 42 {
		t.Fatalf("probe = %+v, %v", probe, err)
	}
	if err := client.Deactivate(context.Background()); err != nil {
		t.Fatalf("deactivate: %v", err)
	}
	if client.ConnectKey() != "" {
		t.Fatal("deactivate did not clear key")
	}
	if len(requests) != 10 {
		t.Fatalf("requests = %v", requests)
	}
}

func TestRealClientErrors(t *testing.T) {
	tests := []struct {
		name       string
		status     int
		body       string
		want       string
		statusCode int
	}{
		{"json API error", http.StatusUnauthorized, `{"error":"bad key"}`, "bad key", http.StatusUnauthorized},
		{"empty API error", http.StatusConflict, `{}`, "HTTP 409", http.StatusConflict},
		{"malformed success", http.StatusOK, `{`, "unexpected", 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.status)
				_, _ = w.Write([]byte(tt.body))
			}))
			defer server.Close()
			client := NewRealClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
			_, err := client.Status(context.Background())
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("error = %v, want %q", err, tt.want)
			}
			if tt.statusCode != 0 {
				var apiErr *ConnectAPIError
				if !errors.As(err, &apiErr) || apiErr.StatusCode != tt.statusCode {
					t.Fatalf("API error = %#v", err)
				}
			}
		})
	}

	for _, operation := range []func(*RealClient) error{
		func(c *RealClient) error { return c.RegisterRoute(context.Background(), "x") },
		func(c *RealClient) error { return c.UnregisterRoute(context.Background(), "x") },
		func(c *RealClient) error { return c.DeleteTunnel(context.Background()) },
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.WriteHeader(http.StatusTeapot)
		}))
		client := NewRealClient(Config{BaseURL: server.URL, HTTPClient: server.Client()})
		if err := operation(client); err == nil || !strings.Contains(err.Error(), "418") {
			t.Errorf("operation error = %v", err)
		}
		server.Close()
	}

	badURL := NewRealClient(Config{BaseURL: "://bad"})
	if _, err := badURL.Status(context.Background()); err == nil || !strings.Contains(err.Error(), "create request") {
		t.Fatalf("invalid URL error = %v", err)
	}

	closed := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	client := NewRealClient(Config{BaseURL: closed.URL, HTTPClient: closed.Client()})
	closed.Close()
	if _, err := client.Status(context.Background()); err == nil || !strings.Contains(err.Error(), "connect request failed") {
		t.Fatalf("network error = %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	if _, err := client.doRequest(req.Context(), http.MethodPost, "/bad", make(chan int)); err == nil ||
		!strings.Contains(err.Error(), "marshal request body") {
		t.Fatalf("marshal error = %v", err)
	}
}

func TestFakeClientLifecycleAndProvisioning(t *testing.T) {
	fake := NewFakeClient()
	ctx := context.Background()
	key := "one-test-connect-key-123456789"

	status, err := fake.Activate(ctx, key)
	if err != nil || !status.Connected || status.Plan.ID != PlanOne || fake.ConnectKey() != key {
		t.Fatalf("activate = %+v, %v", status, err)
	}
	for _, service := range []ServiceID{ServiceSMTP, ServiceDomain, ServiceBackup, ServiceTunnel, ServiceAI} {
		creds, err := fake.Provision(ctx, service)
		if err != nil {
			t.Fatalf("provision %s: %v", service, err)
		}
		switch service {
		case ServiceSMTP:
			if creds.SMTP == nil {
				t.Fatal("missing SMTP credentials")
			}
		case ServiceDomain:
			if creds.Domain == nil {
				t.Fatal("missing domain credentials")
			}
		case ServiceBackup:
			if creds.Backup == nil {
				t.Fatal("missing backup credentials")
			}
		case ServiceTunnel:
			if creds.Tunnel == nil {
				t.Fatal("missing tunnel credentials")
			}
		case ServiceAI:
			if creds.AI == nil {
				t.Fatal("missing AI credentials")
			}
		}
	}
	status, err = fake.Status(ctx)
	if err != nil || status.Services[ServiceDomain].Details["domain"] == "" ||
		status.Services[ServiceSupport].State != ServiceConnected {
		t.Fatalf("provisioned status = %+v, %v", status, err)
	}
	if usage, err := fake.Usage(ctx); err != nil || usage.RemainingUSD <= 0 {
		t.Fatalf("usage = %+v, %v", usage, err)
	}
	if info, err := fake.Info(ctx); err != nil || len(info.Plans) != 3 || len(info.PlanLimits) != 3 {
		t.Fatalf("info = %+v, %v", info, err)
	}
	if err := fake.RegisterRoute(ctx, "app.example.com"); err != nil {
		t.Fatal(err)
	}
	if err := fake.UnregisterRoute(ctx, "app.example.com"); err != nil {
		t.Fatal(err)
	}
	if err := fake.DeleteTunnel(ctx); err != nil {
		t.Fatal(err)
	}

	originalVerify := FakeVerifyResult
	t.Cleanup(func() { FakeVerifyResult = originalVerify })
	FakeVerifyResult = &VerifyProbeResult{Reachable: true, LatencyMS: 5}
	if result, err := fake.VerifyProbe(ctx, "x", 80, "http"); err != nil || !result.Reachable {
		t.Fatalf("verify = %+v, %v", result, err)
	}
	FakeVerifyResult = nil
	if result, err := fake.VerifyProbe(ctx, "x", 80, ""); err != nil || result.Reachable {
		t.Fatalf("unreachable verify = %+v, %v", result, err)
	}

	if err := fake.Deactivate(ctx); err != nil {
		t.Fatal(err)
	}
	status, _ = fake.Status(ctx)
	if status.Connected || fake.ConnectKey() != "" || status.Services[ServiceSMTP].State != ServiceDisabled {
		t.Fatalf("deactivated status = %+v", status)
	}
}

func TestNewClientFromEnv(t *testing.T) {
	original := config.Get()
	t.Cleanup(func() { config.SetTestConfig(original) })
	config.SetTestConfig(&config.Config{Connect: config.ConnectConfig{
		Token:  "config-key-long-enough",
		APIURL: "https://config.example.com",
	}})

	t.Setenv("LIBRESERV_CONNECT_FAKE", "true")
	t.Setenv("LIBRESERV_CONNECT_KEY", "")
	t.Setenv("LIBRESERV_CONNECT_API_URL", "")
	fake, ok := NewClientFromEnv().(*FakeClient)
	if !ok || fake.ConnectKey() != "config-key-long-enough" {
		t.Fatalf("config fake = %#v", fake)
	}

	t.Setenv("LIBRESERV_CONNECT_FAKE", "false")
	t.Setenv("LIBRESERV_CONNECT_KEY", "env-key")
	t.Setenv("LIBRESERV_CONNECT_API_URL", "https://env.example.com/")
	real, ok := NewClientFromEnv().(*RealClient)
	if !ok || real.ConnectKey() != "env-key" || real.baseURL != "https://env.example.com" {
		t.Fatalf("env real = %#v", real)
	}

	defaults := NewRealClient(Config{})
	if defaults.baseURL != "https://connect.serv.libreloom.org" || defaults.client == nil {
		t.Fatalf("default real client = %#v", defaults)
	}
}

func TestConnectHelpersAndDefaults(t *testing.T) {
	if got := connectKeyHint("1234567890"); got != "1234...7890" {
		t.Fatalf("long key hint = %q", got)
	}
	if got := connectKeyHint("short"); got != "short" {
		t.Fatalf("short key hint = %q", got)
	}
	states := DefaultServiceStates()
	if len(states) != len(AllServices) {
		t.Fatalf("default states = %+v", states)
	}
	for _, service := range AllServices {
		if states[service].State != ServiceDisabled || states[service].Label == "" {
			t.Errorf("bad default for %s: %+v", service, states[service])
		}
	}
}
