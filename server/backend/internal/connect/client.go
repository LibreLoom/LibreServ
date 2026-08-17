package connect

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

type Client interface {
	Activate(ctx context.Context, key string) (*ConnectStatus, error)
	Deactivate(ctx context.Context) error
	Provision(ctx context.Context, service ServiceID) (*ProvisionedCredentials, error)
	RegisterRoute(ctx context.Context, hostname string) error
	UnregisterRoute(ctx context.Context, hostname string) error
	DeleteTunnel(ctx context.Context) error
	Status(ctx context.Context) (*ConnectStatus, error)
	Usage(ctx context.Context) (*UsageSummary, error)
	Info(ctx context.Context) (*ConnectInfo, error)
	VerifyProbe(ctx context.Context, host string, port int, protocol string) (*VerifyProbeResult, error)
	ConnectKey() string
}

type Config struct {
	ConnectKey string
	BaseURL    string
	HTTPClient *http.Client
}

type RealClient struct {
	connectKey string
	baseURL    string
	client     *http.Client
	mu         sync.RWMutex
}

func NewRealClient(cfg Config) *RealClient {
	if cfg.HTTPClient == nil {
		cfg.HTTPClient = &http.Client{Timeout: 30 * time.Second}
	}
	if cfg.BaseURL == "" {
		cfg.BaseURL = "https://connect.serv.libreloom.org"
	}
	return &RealClient{
		connectKey: cfg.ConnectKey,
		baseURL:    strings.TrimRight(cfg.BaseURL, "/"),
		client:     cfg.HTTPClient,
	}
}

func (c *RealClient) ConnectKey() string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.connectKey
}

func (c *RealClient) doRequest(ctx context.Context, method, path string, body interface{}) (*http.Response, error) {
	c.mu.RLock()
	key := c.connectKey
	c.mu.RUnlock()

	url := c.baseURL + path
	var req *http.Request
	var err error

	if body != nil {
		jsonBody, err := json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("marshal request body: %w", err)
		}
		req, err = http.NewRequestWithContext(ctx, method, url, strings.NewReader(string(jsonBody)))
		if err != nil {
			return nil, fmt.Errorf("create request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
	} else {
		req, err = http.NewRequestWithContext(ctx, method, url, nil)
		if err != nil {
			return nil, fmt.Errorf("create request: %w", err)
		}
	}

	if key != "" {
		req.Header.Set("Authorization", "Bearer "+key)
	}

	resp, err := c.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("connect request failed: %w", err)
	}
	return resp, nil
}

// ConnectAPIError is returned when the Connect cloud responds with a non-2xx
// status. StatusCode lets callers tell an invalid key (401) from a revoked key
// (403) or an already-activated account (409) apart from each other and from
// network failures (plain wrapped errors), so user-facing messages can say
// what actually went wrong instead of a generic "could not connect".
type ConnectAPIError struct {
	StatusCode int
	Message    string
}

func (e *ConnectAPIError) Error() string { return e.Message }

func (c *RealClient) parseResponse(resp *http.Response, target interface{}) error {
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		var errBody struct {
			Error string `json:"error"`
		}
		json.NewDecoder(resp.Body).Decode(&errBody)
		msg := errBody.Error
		if msg == "" {
			msg = fmt.Sprintf("connect server returned HTTP %d", resp.StatusCode)
		}
		return &ConnectAPIError{StatusCode: resp.StatusCode, Message: msg}
	}

	if target != nil {
		return json.NewDecoder(resp.Body).Decode(target)
	}
	return nil
}

func (c *RealClient) Activate(ctx context.Context, key string) (*ConnectStatus, error) {
	c.mu.Lock()
	c.connectKey = key
	c.mu.Unlock()

	resp, err := c.doRequest(ctx, http.MethodPost, "/api/v1/activate", ActivationRequest{ConnectKey: key})
	if err != nil {
		return nil, err
	}

	var status ConnectStatus
	if err := c.parseResponse(resp, &status); err != nil {
		return nil, err
	}
	return &status, nil
}

func (c *RealClient) Deactivate(ctx context.Context) error {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/v1/deactivate", nil)
	if err != nil {
		return err
	}

	c.mu.Lock()
	c.connectKey = ""
	c.mu.Unlock()

	return c.parseResponse(resp, nil)
}

func (c *RealClient) Provision(ctx context.Context, service ServiceID) (*ProvisionedCredentials, error) {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/v1/services/provision", map[string]string{
		"service": string(service),
	})
	if err != nil {
		return nil, err
	}

	var creds ProvisionedCredentials
	if err := c.parseResponse(resp, &creds); err != nil {
		return nil, err
	}
	return &creds, nil
}

func (c *RealClient) RegisterRoute(ctx context.Context, hostname string) error {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/v1/routes", map[string]string{
		"hostname": hostname,
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("connect returned %d for route registration", resp.StatusCode)
	}
	return nil
}

func (c *RealClient) UnregisterRoute(ctx context.Context, hostname string) error {
	resp, err := c.doRequest(ctx, http.MethodDelete, "/api/v1/routes", map[string]string{
		"hostname": hostname,
	})
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("connect returned %d for route removal", resp.StatusCode)
	}
	return nil
}

// DeleteTunnel asks Connect to delete this device's Cloudflare tunnel.
// POST /api/v1/tunnel/delete (device auth).
func (c *RealClient) DeleteTunnel(ctx context.Context) error {
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/v1/tunnel/delete", nil)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("connect returned %d for tunnel deletion", resp.StatusCode)
	}
	return nil
}

func (c *RealClient) Status(ctx context.Context) (*ConnectStatus, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, "/api/v1/status", nil)
	if err != nil {
		return nil, err
	}

	var status ConnectStatus
	if err := c.parseResponse(resp, &status); err != nil {
		return nil, err
	}
	return &status, nil
}

func (c *RealClient) Usage(ctx context.Context) (*UsageSummary, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, "/api/v1/usage", nil)
	if err != nil {
		return nil, err
	}

	var usage UsageSummary
	if err := c.parseResponse(resp, &usage); err != nil {
		return nil, err
	}
	return &usage, nil
}

func (c *RealClient) Info(ctx context.Context) (*ConnectInfo, error) {
	resp, err := c.doRequest(ctx, http.MethodGet, "/api/v1/info", nil)
	if err != nil {
		return nil, err
	}

	var info ConnectInfo
	if err := c.parseResponse(resp, &info); err != nil {
		return nil, err
	}
	return &info, nil
}

type FakeClient struct {
	mu         sync.RWMutex
	connectKey string
	connected  bool
	plan       *ConnectPlan
	services   map[ServiceID]ServiceStatus
	// errorStatus, if set, is returned by Status() instead of the normal response.
	errorStatus error
}

func NewFakeClient() *FakeClient {
	return &FakeClient{
		connected: false,
		services:  defaultServiceStates(),
	}
}

func defaultServiceStates() map[ServiceID]ServiceStatus {
	return DefaultServiceStates()
}

func (f *FakeClient) ConnectKey() string {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.connectKey
}

func (f *FakeClient) Activate(ctx context.Context, key string) (*ConnectStatus, error) {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.connectKey = key
	f.connected = true

	var plan *ConnectPlan
	switch {
	case strings.Contains(key, "one"):
		plan = &ConnectPlan{ID: PlanOne, Name: "Connect One"}
	case strings.Contains(key, "lite"):
		plan = &ConnectPlan{ID: PlanLite, Name: "Connect Lite"}
	default:
		plan = &ConnectPlan{ID: PlanFree, Name: "Connect Free"}
	}
	f.plan = plan

	// Reset all services to disabled — the caller (Activate handler) will
	// auto-provision each one, mirroring the real Connect API which returns
	// services as disabled until credentials are provisioned. Services the
	// user already set to BYO are preserved.
	for id, svc := range f.services {
		if svc.State != ServiceBYO {
			newSvc := svc
			newSvc.State = ServiceDisabled
			f.services[id] = newSvc
		}
	}

	slog.Info("fake connect activated", "key", connectKeyHint(key), "plan", plan.ID)
	return f.buildStatusLocked(), nil
}

func (f *FakeClient) Deactivate(ctx context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()

	f.connectKey = ""
	f.connected = false
	f.plan = nil
	for id, svc := range f.services {
		if svc.State == ServiceConnected {
			newSvc := svc
			newSvc.State = ServiceDisabled
			f.services[id] = newSvc
		}
	}
	return nil
}

func (f *FakeClient) Provision(ctx context.Context, service ServiceID) (*ProvisionedCredentials, error) {
	f.mu.Lock()
	// Mark the service as connected in the fake's internal state so that
	// subsequent Status calls reflect the provisioned state, mirroring the
	// real Connect API which marks services connected after provisioning.
	if svc, ok := f.services[service]; ok && svc.State == ServiceDisabled {
		svc.State = ServiceConnected
		f.services[service] = svc
	}
	f.mu.Unlock()

	creds := &ProvisionedCredentials{}

	switch service {
	case ServiceSMTP:
		creds.SMTP = &SMTPCredentials{
			Host:     "smtp.libreloom.org",
			Port:     587,
			Username: fmt.Sprintf("server-%s", f.connectKey[:8]),
			Password: "provisioned-smtp-password",
			From:     fmt.Sprintf("server@%s.servers.libreloom.org", f.connectKey[:8]),
			UseTLS:   true,
		}
	case ServiceDomain:
		sub := f.connectKey[:8]
		domain := sub + ".servers.libreloom.org"
		creds.Domain = &DomainCredentials{
			Domain:    domain,
			Provider:  "connect",
			AutoHTTPS: true,
		}
	case ServiceBackup:
		creds.Backup = &BackupCredentials{
			RepoType: "s3",
			RepoPath: fmt.Sprintf("s3:https://s3.libreloom.org/libreserv-backup/%s", f.connectKey[:8]),
			Password: "restic-connect-password",
			Env: map[string]string{
				"AWS_ACCESS_KEY_ID":     f.connectKey[:16],
				"AWS_SECRET_ACCESS_KEY": "provisioned-secret-key",
			},
		}
	case ServiceTunnel:
		creds.Tunnel = &TunnelCredentials{
			Provider:    "cloudflare",
			TunnelToken: "tunnel-token-" + f.connectKey[:8],
			TunnelID:    "fake-tunnel-id-" + f.connectKey[:8],
		}
	case ServiceAI:
		sub := ""
		if len(f.connectKey) >= 8 {
			sub = f.connectKey[:8]
		}
		creds.AI = &AICredentials{
			BaseURL: "https://inference.neuralwatt.dev/v1",
			APIKey:  "nw-sk-" + sub + "-fake",
			Format:  "openai",
		}
	}

	return creds, nil
}

func (f *FakeClient) RegisterRoute(ctx context.Context, hostname string) error {
	return nil
}

func (f *FakeClient) UnregisterRoute(ctx context.Context, hostname string) error {
	return nil
}

func (f *FakeClient) DeleteTunnel(ctx context.Context) error {
	return nil
}

func (f *FakeClient) Status(ctx context.Context) (*ConnectStatus, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	if f.errorStatus != nil {
		return nil, f.errorStatus
	}
	return f.buildStatusLocked(), nil
}

func (f *FakeClient) buildStatusLocked() *ConnectStatus {
	svcs := make(map[ServiceID]ServiceStatus, len(f.services))
	for id, svc := range f.services {
		// Populate domain details so the UI knows the actual served subdomain.
		if id == ServiceDomain && svc.State == ServiceConnected && f.connectKey != "" {
			svc.Details = map[string]string{
				"type":   "subdomain",
				"domain": f.connectKey[:min(8, len(f.connectKey))] + ".servers.libreloom.org",
			}
		}
		svcs[id] = svc
	}

	// Mirror the real Connect server: human support is a plan entitlement,
	// not a provisionable service. Plans that include it report it as
	// connected, the free plan as unavailable, and a device with no active
	// plan stays disabled (the default state).
	if f.plan != nil {
		state := ServiceUnavailable
		if f.plan.ID == PlanOne || f.plan.ID == PlanLite {
			state = ServiceConnected
		}
		svcs[ServiceSupport] = ServiceStatus{State: state, Label: "Human Support"}
	}

	var hint string
	if len(f.connectKey) > 4 {
		hint = f.connectKey[:4] + "..."
	}

	return &ConnectStatus{
		Connected:      f.connected,
		Plan:           f.plan,
		Services:       svcs,
		ConnectKeyHint: hint,
	}
}

func (f *FakeClient) Usage(ctx context.Context) (*UsageSummary, error) {
	return &UsageSummary{
		CurrentCycleStart: time.Now().AddDate(0, 0, -15),
		CurrentCycleEnd:   time.Now().AddDate(0, 0, 15),
		TotalCostUSD:      0.45,
		CreditCapUSD:      10.00,
		RemainingUSD:      9.55,
	}, nil
}

// FakeVerifyResult overrides VerifyProbe behavior in tests.
var FakeVerifyResult *VerifyProbeResult = &VerifyProbeResult{Reachable: true}

func (f *FakeClient) VerifyProbe(ctx context.Context, host string, port int, protocol string) (*VerifyProbeResult, error) {
	if FakeVerifyResult == nil {
		return &VerifyProbeResult{Reachable: false, Error: "unreachable"}, nil
	}
	return FakeVerifyResult, nil
}

func (f *FakeClient) Info(ctx context.Context) (*ConnectInfo, error) {
	plans := []PlanInfo{
		{ID: PlanFree, Name: "Connect Free", Description: "Get started with basic services. No credit card required.", PriceMonthly: 0},
		{ID: PlanLite, Name: "Connect Lite", Description: "Essential services for a fixed monthly price.", PriceMonthly: 600},
		{ID: PlanOne, Name: "Connect One", Description: "All services, unlimited. Fixed monthly price.", PriceMonthly: 2500},
	}
	limits := map[PlanID]PlanLimits{
		PlanFree: {MaxEmailsPerDay: 30, TunnelGBPerMo: 0, BackupGB: 0, AIMessagesPerDay: 50, AICreditCents: 0, Domain: "*.free.servers.libreloom.org"},
		PlanLite: {MaxEmailsPerDay: 0, TunnelGBPerMo: 0, BackupGB: 100, AIMessagesPerDay: 0, AICreditCents: 200, Domain: "*.servers.libreloom.org"},
		PlanOne:  {MaxEmailsPerDay: 0, TunnelGBPerMo: 0, BackupGB: 1024, AIMessagesPerDay: 0, AICreditCents: 500, Domain: "*.servers.libreloom.org"},
	}
	return &ConnectInfo{
		Plans:      plans,
		PlanLimits: limits,
	}, nil
}

func connectKeyHint(key string) string {
	if len(key) > 8 {
		return key[:4] + "..." + key[len(key)-4:]
	}
	return key
}

// VerifyProbeResult is the outcome of a verify-probe call.
type VerifyProbeResult struct {
	Reachable bool   `json:"reachable"`
	LatencyMS int64  `json:"latency_ms,omitempty"`
	Error     string `json:"error,omitempty"`
}

// VerifyProbe asks Connect to probe host:port from outside. The device cannot
// grade its own homework — Connect's edge is the source of truth for
// inbound_open. Requires an active Connect account (free tier counts).
func (c *RealClient) VerifyProbe(ctx context.Context, host string, port int, protocol string) (*VerifyProbeResult, error) {
	body := map[string]any{"host": host, "port": port}
	if protocol != "" {
		body["protocol"] = protocol
	}
	resp, err := c.doRequest(ctx, http.MethodPost, "/api/v1/verify-probe", body)
	if err != nil {
		return nil, err
	}

	var result VerifyProbeResult
	if err := c.parseResponse(resp, &result); err != nil {
		return nil, err
	}
	return &result, nil
}
