package connect

import "time"

type ServiceState string

const (
	ServiceDisabled  ServiceState = "disabled"
	ServiceConnected ServiceState = "connected"
	ServiceBYO       ServiceState = "byo"
)

type PlanID string

const (
	PlanFree PlanID = "free"
	PlanOne  PlanID = "one"
	PlanLite PlanID = "lite"
)

type ConnectPlan struct {
	ID   PlanID `json:"id"`
	Name string `json:"name"`
}

type ServiceID string

const (
	ServiceSMTP    ServiceID = "smtp"
	ServiceDomain  ServiceID = "domain"
	ServiceBackup  ServiceID = "backup"
	ServiceTunnel  ServiceID = "tunnel"
	ServiceACME    ServiceID = "acme"
	ServiceAI      ServiceID = "ai"
	ServiceSupport ServiceID = "support"
)

var AllServices = []ServiceID{
	ServiceSMTP,
	ServiceDomain,
	ServiceBackup,
	ServiceTunnel,
	ServiceAI,
	ServiceSupport,
}

func DefaultServiceStates() map[ServiceID]ServiceStatus {
	return map[ServiceID]ServiceStatus{
		ServiceSMTP:    {State: ServiceDisabled, Label: "Email / SMTP"},
		ServiceDomain:  {State: ServiceDisabled, Label: "Domain & DNS"},
		ServiceBackup:  {State: ServiceDisabled, Label: "Cloud Backup Storage"},
		ServiceTunnel:  {State: ServiceDisabled, Label: "Tunnel"},
		ServiceAI:      {State: ServiceDisabled, Label: "AI Assistant"},
		ServiceSupport: {State: ServiceDisabled, Label: "Human Support"},
	}
}

type ServiceStatus struct {
	State   ServiceState      `json:"state"`
	Label   string            `json:"label"`
	Details map[string]string `json:"details,omitempty"`
}

type ConnectStatus struct {
	Connected bool                        `json:"connected"`
	Plan      *ConnectPlan                `json:"plan,omitempty"`
	Services  map[ServiceID]ServiceStatus `json:"services"`
	TokenHint string                      `json:"token_hint,omitempty"`
}

type UsageSummary struct {
	CurrentCycleStart time.Time `json:"current_cycle_start"`
	CurrentCycleEnd   time.Time `json:"current_cycle_end"`
	TotalCostUSD      float64   `json:"total_cost_usd"`
	CreditCapUSD      float64   `json:"credit_cap_usd"`
	RemainingUSD      float64   `json:"remaining_usd"`
}

type ServiceToggleRequest struct {
	Service ServiceID    `json:"service"`
	State   ServiceState `json:"state"`
}

type ActivationRequest struct {
	Token string `json:"token"`
}

type AICredentials struct {
	BaseURL string `json:"base_url"`
	APIKey  string `json:"api_key"`
	Format  string `json:"format,omitempty"`
}

type ProvisionedCredentials struct {
	SMTP   *SMTPCredentials   `json:"smtp,omitempty"`
	Domain *DomainCredentials `json:"domain,omitempty"`
	Backup *BackupCredentials `json:"backup,omitempty"`
	Tunnel *TunnelCredentials `json:"tunnel,omitempty"`
	AI     *AICredentials     `json:"ai,omitempty"`
}

type SMTPCredentials struct {
	Host     string `json:"host"`
	Port     int    `json:"port"`
	Username string `json:"username"`
	Password string `json:"password"`
	From     string `json:"from"`
	UseTLS   bool   `json:"use_tls"`
}

type DomainCredentials struct {
	Domain    string `json:"domain"`
	Provider  string `json:"provider"`
	APIToken  string `json:"api_token,omitempty"`
	AutoHTTPS bool   `json:"auto_https"`
}

type BackupCredentials struct {
	RepoType string            `json:"repo_type"`
	RepoPath string            `json:"repo_path"`
	Password string            `json:"password"`
	Env      map[string]string `json:"env,omitempty"`
}

type TunnelCredentials struct {
	Provider    string `json:"provider"`
	TunnelToken string `json:"tunnel_token"`
	TunnelID    string `json:"tunnel_id"`
}

type ConnectInfo struct {
	Plans      []PlanInfo            `json:"plans"`
	PlanLimits map[PlanID]PlanLimits `json:"plan_limits"`
}

type PlanInfo struct {
	ID           PlanID `json:"id"`
	Name         string `json:"name"`
	Description  string `json:"description"`
	PriceMonthly int    `json:"price_monthly"`
}

type PlanLimits struct {
	MaxEmailsPerDay int `json:"max_emails_per_day"`
	TunnelMbps      int `json:"tunnel_mbps"`
	TunnelGBPerMo   int `json:"tunnel_gb_per_mo"`
	BackupGB        int `json:"backup_gb"`
	AIMessagesPerMo int `json:"ai_messages_per_mo"`
}
