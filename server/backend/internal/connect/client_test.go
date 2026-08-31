package connect

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

type errorRoundTripper struct{ err error }

func (r errorRoundTripper) RoundTrip(*http.Request) (*http.Response, error) { return nil, r.err }

func TestRealClientAPI(t *testing.T) {
	var mu sync.Mutex
	requests := make(map[string]struct {
		method string
		auth   string
		body   string
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		mu.Lock()
		requests[r.URL.Path] = struct {
			method string
			auth   string
			body   string
		}{r.Method, r.Header.Get("Authorization"), string(raw)}
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/v1/activate":
			_, _ = io.WriteString(w, `{"connected":true,"connect_key_hint":"abcd..."}`)
		case "/api/v1/deactivate":
			w.WriteHeader(http.StatusNoContent)
		case "/api/v1/services/provision":
			_, _ = io.WriteString(w, `{"smtp":{"host":"smtp.example.com","port":587}}`)
		case "/api/v1/routes", "/api/v1/tunnel/delete":
			_, _ = io.WriteString(w, `{}`)
		case "/api/v1/status":
			_, _ = io.WriteString(w, `{"connected":true,"plan":{"id":"one","name":"Connect One"},"services":{}}`)
		case "/api/v1/usage":
			_, _ = io.WriteString(w, `{"total_cost_usd":1.25,"remaining_usd":8.75}`)
		case "/api/v1/info":
			_, _ = io.WriteString(w, `{"plans":[{"id":"free","name":"Free"}],"plan_limits":{}}`)
		case "/api/v1/verify-probe":
			_, _ = io.WriteString(w, `{"reachable":true,"latency_ms":12}`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	client := NewRealClient(Config{ConnectKey: "old-key", BaseURL: server.URL + "/"})
	status, err := client.Activate(context.Background(), "new-key")
	if err != nil || !status.Connected || client.ConnectKey() != "new-key" {
		t.Fatalf("Activate = %+v, key=%q, err=%v", status, client.ConnectKey(), err)
	}
	creds, err := client.Provision(context.Background(), ServiceSMTP)
	if err != nil || creds.SMTP == nil || creds.SMTP.Host != "smtp.example.com" {
		t.Fatalf("Provision = %+v, %v", creds, err)
	}
	if err := client.RegisterRoute(context.Background(), "app.example.com"); err != nil {
		t.Fatalf("RegisterRoute: %v", err)
	}
	if err := client.UnregisterRoute(context.Background(), "app.example.com"); err != nil {
		t.Fatalf("UnregisterRoute: %v", err)
	}
	if err := client.DeleteTunnel(context.Background()); err != nil {
		t.Fatalf("DeleteTunnel: %v", err)
	}
	status, err = client.Status(context.Background())
	if err != nil || status.Plan == nil || status.Plan.ID != PlanOne {
		t.Fatalf("Status = %+v, %v", status, err)
	}
	usage, err := client.Usage(context.Background())
	if err != nil || usage.TotalCostUSD != 1.25 {
		t.Fatalf("Usage = %+v, %v", usage, err)
	}
	info, err := client.Info(context.Background())
	if err != nil || len(info.Plans) != 1 || info.Plans[0].ID != PlanFree {
		t.Fatalf("Info = %+v, %v", info, err)
	}
	probe, err := client.VerifyProbe(context.Background(), "example.com", 443, "tcp")
	if err != nil || !probe.Reachable || probe.LatencyMS != 12 {
		t.Fatalf("VerifyProbe = %+v, %v", probe, err)
	}
	if err := client.Deactivate(context.Background()); err != nil || client.ConnectKey() != "" {
		t.Fatalf("Deactivate key=%q, err=%v", client.ConnectKey(), err)
	}

	mu.Lock()
	defer mu.Unlock()
	if req := requests["/api/v1/activate"]; req.method != http.MethodPost ||
		req.auth != "Bearer new-key" || !strings.Contains(req.body, `"connect_key":"new-key"`) {
		t.Fatalf("activate request = %+v", req)
	}
	if req := requests["/api/v1/routes"]; req.method != http.MethodDelete ||
		!strings.Contains(req.body, `"hostname":"app.example.com"`) {
		t.Fatalf("route request = %+v", req)
	}
	if req := requests["/api/v1/verify-probe"]; !strings.Contains(req.body, `"port":443`) ||
		!strings.Contains(req.body, `"protocol":"tcp"`) {
		t.Fatalf("probe request = %+v", req)
	}
}

func TestRealClientResponseAndRequestErrors(t *testing.T) {
	tests := []struct {
		name       string
		statusCode int
		body       string
		want       string
	}{
		{"JSON API error", http.StatusUnauthorized, `{"error":"invalid key"}`, "invalid key"},
		{"fallback API error", http.StatusBadGateway, `not-json`, "HTTP 502"},
		{"invalid success JSON", http.StatusOK, `{`, "unexpected"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tt.statusCode)
				_, _ = io.WriteString(w, tt.body)
			}))
			defer server.Close()
			client := NewRealClient(Config{BaseURL: server.URL})
			_, err := client.Status(context.Background())
			if err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("Status error = %v, want %q", err, tt.want)
			}
			if tt.statusCode != http.StatusOK {
				var apiErr *ConnectAPIError
				if !errors.As(err, &apiErr) || apiErr.StatusCode != tt.statusCode {
					t.Fatalf("error type = %T (%v)", err, err)
				}
			}
		})
	}

	transportErr := errors.New("network down")
	client := NewRealClient(Config{
		BaseURL:    "http://connect.invalid",
		HTTPClient: &http.Client{Transport: errorRoundTripper{err: transportErr}},
	})
	if _, err := client.Status(context.Background()); err == nil ||
		!strings.Contains(err.Error(), "connect request failed") {
		t.Fatalf("transport error = %v", err)
	}
	client = NewRealClient(Config{BaseURL: ":"})
	if _, err := client.doRequest(context.Background(), http.MethodGet, "/bad", nil); err == nil ||
		!strings.Contains(err.Error(), "create request") {
		t.Fatalf("request creation error = %v", err)
	}
	if _, err := client.doRequest(context.Background(), http.MethodPost, "/bad", func() {}); err == nil ||
		!strings.Contains(err.Error(), "marshal request body") {
		t.Fatalf("marshal error = %v", err)
	}
}

func TestRealClientRouteStatusErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusConflict)
	}))
	defer server.Close()
	client := NewRealClient(Config{BaseURL: server.URL})
	if err := client.RegisterRoute(context.Background(), "host"); err == nil || !strings.Contains(err.Error(), "registration") {
		t.Fatalf("RegisterRoute error = %v", err)
	}
	if err := client.UnregisterRoute(context.Background(), "host"); err == nil || !strings.Contains(err.Error(), "removal") {
		t.Fatalf("UnregisterRoute error = %v", err)
	}
	if err := client.DeleteTunnel(context.Background()); err == nil || !strings.Contains(err.Error(), "deletion") {
		t.Fatalf("DeleteTunnel error = %v", err)
	}
}

func TestNewRealClientDefaults(t *testing.T) {
	client := NewRealClient(Config{})
	if client.baseURL != "https://connect.serv.libreloom.org" ||
		client.client == nil || client.client.Timeout != 30*time.Second {
		t.Fatalf("unexpected client defaults: %+v", client)
	}
}

func TestFakeClientLifecycleProvisioningAndInfo(t *testing.T) {
	ctx := context.Background()
	fake := NewFakeClient()
	status, err := fake.Status(ctx)
	if err != nil || status.Connected || len(status.Services) != len(AllServices) {
		t.Fatalf("initial status = %+v, %v", status, err)
	}
	fake.services[ServiceSMTP] = ServiceStatus{State: ServiceBYO, Label: "Email / SMTP"}
	status, err = fake.Activate(ctx, "1234567890abcdef-one")
	if err != nil || !status.Connected || status.Plan.ID != PlanOne ||
		status.Services[ServiceSMTP].State != ServiceBYO ||
		status.Services[ServiceSupport].State != ServiceConnected {
		t.Fatalf("activated status = %+v, %v", status, err)
	}
	if fake.ConnectKey() != "1234567890abcdef-one" || status.ConnectKeyHint != "1234..." {
		t.Fatalf("key/hint = %q/%q", fake.ConnectKey(), status.ConnectKeyHint)
	}

	for _, service := range []ServiceID{ServiceSMTP, ServiceDomain, ServiceBackup, ServiceTunnel, ServiceAI, "unknown"} {
		creds, err := fake.Provision(ctx, service)
		if err != nil {
			t.Fatalf("Provision(%q): %v", service, err)
		}
		switch service {
		case ServiceSMTP:
			if creds.SMTP == nil || creds.SMTP.Username == "" {
				t.Errorf("missing SMTP credentials: %+v", creds)
			}
		case ServiceDomain:
			if creds.Domain == nil || creds.Domain.Domain == "" {
				t.Errorf("missing domain credentials: %+v", creds)
			}
		case ServiceBackup:
			if creds.Backup == nil || len(creds.Backup.Env) != 2 {
				t.Errorf("missing backup credentials: %+v", creds)
			}
		case ServiceTunnel:
			if creds.Tunnel == nil || creds.Tunnel.TunnelID == "" {
				t.Errorf("missing tunnel credentials: %+v", creds)
			}
		case ServiceAI:
			if creds.AI == nil || creds.AI.APIKey == "" {
				t.Errorf("missing AI credentials: %+v", creds)
			}
		}
	}
	status, _ = fake.Status(ctx)
	if status.Services[ServiceDomain].Details["domain"] == "" {
		t.Fatalf("provisioned domain details missing: %+v", status.Services[ServiceDomain])
	}
	if err := fake.RegisterRoute(ctx, "app.example.com"); err != nil {
		t.Fatalf("RegisterRoute: %v", err)
	}
	if err := fake.UnregisterRoute(ctx, "app.example.com"); err != nil {
		t.Fatalf("UnregisterRoute: %v", err)
	}
	if err := fake.DeleteTunnel(ctx); err != nil {
		t.Fatalf("DeleteTunnel: %v", err)
	}
	usage, err := fake.Usage(ctx)
	if err != nil || usage.RemainingUSD != 9.55 {
		t.Fatalf("Usage = %+v, %v", usage, err)
	}
	info, err := fake.Info(ctx)
	if err != nil || len(info.Plans) != 3 || len(info.PlanLimits) != 3 {
		t.Fatalf("Info = %+v, %v", info, err)
	}
	FakeVerifyResult = &VerifyProbeResult{Reachable: true, LatencyMS: 7}
	t.Cleanup(func() { FakeVerifyResult = &VerifyProbeResult{Reachable: true} })
	probe, _ := fake.VerifyProbe(ctx, "host", 80, "")
	if !probe.Reachable || probe.LatencyMS != 7 {
		t.Fatalf("probe = %+v", probe)
	}
	FakeVerifyResult = nil
	probe, _ = fake.VerifyProbe(ctx, "host", 80, "")
	if probe.Reachable || probe.Error == "" {
		t.Fatalf("nil fake probe = %+v", probe)
	}
	if err := fake.Deactivate(ctx); err != nil {
		t.Fatalf("Deactivate: %v", err)
	}
	status, _ = fake.Status(ctx)
	if status.Connected || status.Plan != nil || fake.ConnectKey() != "" {
		t.Fatalf("deactivated status = %+v", status)
	}

	if connectKeyHint("short") != "short" || connectKeyHint("123456789") != "1234...6789" {
		t.Fatal("unexpected connect key hint")
	}
	states := DefaultServiceStates()
	if len(states) != len(AllServices) || states[ServiceAI].State != ServiceDisabled {
		t.Fatalf("default states = %+v", states)
	}
}

func TestNewClientFromEnvFakeAndConfig(t *testing.T) {
	original := config.Get()
	t.Cleanup(func() { config.SetTestConfig(original) })
	t.Setenv("LIBRESERV_CONNECT_FAKE", "true")
	t.Setenv("LIBRESERV_CONNECT_KEY", "")
	t.Setenv("LIBRESERV_CONNECT_API_URL", "")
	config.SetTestConfig(&config.Config{Connect: config.ConnectConfig{
		Token: "config-key-one-123456", APIURL: "https://connect.example.com/",
	}})
	client := NewClientFromEnv()
	fake, ok := client.(*FakeClient)
	if !ok {
		t.Fatalf("client type = %T, want *FakeClient", client)
	}
	status, err := fake.Status(context.Background())
	if err != nil || !status.Connected || fake.ConnectKey() != "config-key-one-123456" {
		t.Fatalf("fake client status = %+v, key=%q, err=%v", status, fake.ConnectKey(), err)
	}

	t.Setenv("LIBRESERV_CONNECT_FAKE", "false")
	t.Setenv("LIBRESERV_CONNECT_KEY", "env-key")
	t.Setenv("LIBRESERV_CONNECT_API_URL", "https://env.example.com/")
	real, ok := NewClientFromEnv().(*RealClient)
	if !ok || real.ConnectKey() != "env-key" || real.baseURL != "https://env.example.com" {
		t.Fatalf("real client = %+v", real)
	}
}

func TestActivationRequestJSONShape(t *testing.T) {
	raw, err := json.Marshal(ActivationRequest{ConnectKey: "key"})
	if err != nil || string(raw) != `{"connect_key":"key"}` {
		t.Fatalf("activation JSON = %s, %v", raw, err)
	}
}
