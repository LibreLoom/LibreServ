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
	Status(ctx context.Context) (*ConnectStatus, error)
	Usage(ctx context.Context) (*UsageSummary, error)
	Info(ctx context.Context) (*ConnectInfo, error)
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
		return fmt.Errorf("connect API error: %s", msg)
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

	for id, svc := range f.services {
		if svc.State != ServiceBYO {
			newSvc := svc
			newSvc.State = ServiceConnected
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

func (f *FakeClient) Status(ctx context.Context) (*ConnectStatus, error) {
	f.mu.RLock()
	defer f.mu.RUnlock()
	return f.buildStatusLocked(), nil
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

func (f *FakeClient) Info(ctx context.Context) (*ConnectInfo, error) {
	return &ConnectInfo{
		Plans: []PlanInfo{
			{ID: PlanFree, Name: "Connect Free", Description: "Get started with basic services. No credit card required.", PriceMonthly: 0},
			{ID: PlanLite, Name: "Connect Lite", Description: "Essential services for a fixed monthly price.", PriceMonthly: 600},
			{ID: PlanOne, Name: "Connect One", Description: "All services, unlimited. Fixed monthly price.", PriceMonthly: 2500},
		},
		PlanLimits: map[PlanID]PlanLimits{
			PlanFree: {MaxEmailsPerDay: 30, TunnelMbps: 1, TunnelGBPerMo: 1, BackupGB: 0, AIMessagesPerMo: 50},
			PlanLite: {MaxEmailsPerDay: 0, TunnelMbps: 100, TunnelGBPerMo: 50, BackupGB: 100, AIMessagesPerMo: 0},
			PlanOne:  {MaxEmailsPerDay: 0, TunnelMbps: 100, TunnelGBPerMo: 200, BackupGB: 1024, AIMessagesPerMo: 0},
		},
	}, nil
}

func (f *FakeClient) buildStatusLocked() *ConnectStatus {
	svcs := make(map[ServiceID]ServiceStatus, len(f.services))
	for id, svc := range f.services {
		svcs[id] = svc
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

func connectKeyHint(key string) string {
	if len(key) > 8 {
		return key[:4] + "..." + key[len(key)-4:]
	}
	return key
}
