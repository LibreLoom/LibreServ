package apps

import (
	"fmt"
	"maps"
	"slices"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

// AppType represents the type of app in the catalog
type AppType string

const (
	AppTypeRepo AppType = "repo"
	// AppTypeExternal represents externally managed apps registered for monitoring
	AppTypeExternal AppType = "external"
)

// AppCategory represents the category of an app
type AppCategory string

// App categories used for catalog grouping.
const (
	CategoryProductivity AppCategory = "productivity"
	CategoryMedia        AppCategory = "media"
	CategoryDevelopment  AppCategory = "development"
	CategoryUtility      AppCategory = "utility"
	CategoryAI           AppCategory = "ai"
	CategorySearch       AppCategory = "search"
	CategoryStorage      AppCategory = "storage"
	CategorySecurity     AppCategory = "security"
	CategoryOther        AppCategory = "other"
)

// ExposedInfoField represents a field exposed by an app (e.g., credentials, URLs).
type ExposedInfoField struct {
	Name          string `yaml:"name" json:"name"`
	Label         string `yaml:"label" json:"label"`
	Description   string `yaml:"description,omitempty" json:"description,omitempty"`
	Type          string `yaml:"type" json:"type"`                             // password, string, url, username
	Group         string `yaml:"group,omitempty" json:"group,omitempty"`       // Optional grouping (e.g., "credentials", "connection")
	Advanced      bool   `yaml:"advanced,omitempty" json:"advanced,omitempty"` // Hide behind advanced toggle
	Copyable      bool   `yaml:"copyable" json:"copyable"`
	Revealable    bool   `yaml:"revealable" json:"revealable"`
	MaskByDefault bool   `yaml:"mask_by_default" json:"mask_by_default"`
}

type ExposedInfoValue struct {
	Label         string      `json:"label"`
	Description   string      `json:"description,omitempty"`
	Type          string      `json:"type"` // password, string, url, username
	Group         string      `json:"group,omitempty"`
	Advanced      bool        `json:"advanced,omitempty"`
	Value         interface{} `json:"value,omitempty"`
	Copyable      bool        `json:"copyable"`
	Revealable    bool        `json:"revealable"`
	MaskByDefault bool        `json:"mask_by_default"`
}

type AppDefinition struct {
	// Core metadata
	ID          string      `yaml:"id" json:"id"`
	Name        string      `yaml:"name" json:"name"`
	Description string      `yaml:"description" json:"description"`
	Version     string      `yaml:"version" json:"version"`
	Category    AppCategory `yaml:"category" json:"category"`
	Icon        string      `yaml:"icon" json:"icon"`
	Website     string      `yaml:"website" json:"website"`
	Repository  string      `yaml:"repository" json:"repository"`
	Featured    bool        `yaml:"featured" json:"featured"`

	// Deployment configuration
	Deployment DeploymentConfig `yaml:"deployment" json:"deployment"`

	// Access describes how the app must be reached from outside the device
	// (web-only vs direct TCP/UDP ports). Feeds the network decision engine;
	// defaults to web-only when unset.
	Access Access `yaml:"access,omitempty" json:"access,omitempty"`

	// OIDCRedirectPath is the callback path the app uses for OIDC auth.
	// Defaults to /callback if not set. Used by the auto-provisioner to
	// register the correct redirect URI with the OIDC client.
	OIDCRedirectPath string `yaml:"oidc_redirect_path,omitempty" json:"oidc_redirect_path,omitempty"`

	// User-configurable fields shown during installation
	Configuration []ConfigField `yaml:"configuration" json:"configuration"`

	// Exposed info fields - config values to expose to frontend
	ExposedInfo []ExposedInfoField `yaml:"exposed_info,omitempty" json:"exposed_info,omitempty"`

	// Health check configuration
	HealthCheck HealthCheckConfig `yaml:"health_check" json:"health_check"`

	// Resource requirements
	Requirements ResourceRequirements `yaml:"requirements" json:"requirements"`

	// Update configuration
	Updates UpdateConfig `yaml:"updates" json:"updates"`

	// Script configuration
	Scripts ScriptConfig `yaml:"scripts,omitempty" json:"scripts,omitempty"`

	// AccessModel defines how LibreServ handles authentication for this app
	// ("internal" = LibreServ OIDC SSO, "external" = app manages its own auth).
	AccessModel AccessModel `yaml:"access_model,omitempty" json:"access_model,omitempty"`

	// Internal metadata (not from YAML)
	Type          AppType `yaml:"-" json:"type"`
	CatalogPath   string  `yaml:"-" json:"-"`
	SourceRepoURL string  `yaml:"-" json:"source_repo_url,omitempty"`
}

// Access describes how an app must be reached from outside the device.
// The network decision engine uses it to pick an exposure path; users never
// see it — the engine decides and the UI explains the outcome.
type Access struct {
	// Web is true when HTTPS reachability is sufficient (most web apps).
	// Defaults to true when Access is not declared at all.
	Web bool `yaml:"web" json:"web"`

	// Ports lists direct TCP/UDP ports visitors must reach (e.g. Minecraft
	// 25565 tcp+udp) that Web access alone can't cover. Each entry needs its
	// own exposure path (UPnP/direct/relay) because tunnels like cloudflared
	// can't carry arbitrary UDP.
	Ports []PortNeed `yaml:"ports,omitempty" json:"ports,omitempty"`

	// LargeUploads marks apps with request bodies larger than 100MB
	// (e.g. Nextcloud file sync). The engine must never route these through
	// cloudflared — CF free-tier proxies cap request bodies at 100MB.
	LargeUploads bool `yaml:"large_uploads,omitempty" json:"large_uploads,omitempty"`
}

// PortNeed is one direct-port requirement for an app.
type PortNeed struct {
	// Protocol is "tcp", "udp", or "both".
	Protocol string `yaml:"protocol" json:"protocol"`
	// Port is the external port visitors connect to.
	Port int `yaml:"port" json:"port"`
	// VerifyHint names a per-protocol active check used to verify the port
	// from outside (e.g. "bedrock_ping", "echo", "http"). UDP has no
	// connect(); TCP-only probes can't prove a UDP mapping works.
	VerifyHint string `yaml:"verify_hint,omitempty" json:"verify_hint,omitempty"`
}

// ResolveAccess returns the effective access requirements, defaulting an
// undeclared Access to web-only (the common case — most apps are web apps).
func (a *AppDefinition) ResolveAccess() Access {
	if a.Access.Web || len(a.Access.Ports) > 0 || a.Access.LargeUploads {
		return a.Access
	}
	return Access{Web: true}
}

// Clone returns a deep copy of the AppDefinition.
// This prevents callers from mutating the catalog's canonical state.
func (a *AppDefinition) Clone() *AppDefinition {
	c := *a // shallow copy

	// Deep copy slices in Deployment
	c.Deployment.Ports = slices.Clone(a.Deployment.Ports)
	c.Deployment.Volumes = slices.Clone(a.Deployment.Volumes)
	c.Deployment.DependsOn = slices.Clone(a.Deployment.DependsOn)

	// Deep copy maps in Deployment
	if a.Deployment.Environment != nil {
		c.Deployment.Environment = maps.Clone(a.Deployment.Environment)
	}
	if a.Deployment.Labels != nil {
		c.Deployment.Labels = maps.Clone(a.Deployment.Labels)
	}

	// Deep copy top-level slices
	c.Configuration = slices.Clone(a.Configuration)
	c.ExposedInfo = slices.Clone(a.ExposedInfo)
	c.Access.Ports = slices.Clone(a.Access.Ports)

	return &c
}

// DeploymentConfig contains container deployment settings
type DeploymentConfig struct {
	// ComposeFile is the path to compose template (.yml.tmpl) relative to app directory
	ComposeFile string `yaml:"compose_file" json:"compose_file"`

	// Image is for single-container apps (if no compose file)
	Image string `yaml:"image,omitempty" json:"image,omitempty"`

	// Ports to expose (host:container format)
	Ports []PortMapping `yaml:"ports,omitempty" json:"ports,omitempty"`

	// Volumes to mount
	Volumes []VolumeMapping `yaml:"volumes,omitempty" json:"volumes,omitempty"`

	// Environment variables (can use template syntax)
	Environment map[string]string `yaml:"environment,omitempty" json:"environment,omitempty"`

	// Labels to apply to containers
	Labels map[string]string `yaml:"labels,omitempty" json:"labels,omitempty"`

	// Network mode
	NetworkMode string `yaml:"network_mode,omitempty" json:"network_mode,omitempty"`

	// Restart policy
	RestartPolicy string `yaml:"restart_policy,omitempty" json:"restart_policy,omitempty"`

	// Dependencies on other apps
	DependsOn []string `yaml:"depends_on,omitempty" json:"depends_on,omitempty"`

	// Capabilities needed
	Capabilities []string `yaml:"capabilities,omitempty" json:"capabilities,omitempty"`

	// GPU support
	GPU GPUConfig `yaml:"gpu,omitempty" json:"gpu,omitempty"`

	// Explicit backend endpoints (e.g., internal services not exposed via port mapping)
	Backends []BackendEndpoint `yaml:"backends,omitempty" json:"backends,omitempty"`
}

// PortMapping represents a port binding
type PortMapping struct {
	Host      int    `yaml:"host" json:"host"`
	Container int    `yaml:"container" json:"container"`
	Protocol  string `yaml:"protocol,omitempty" json:"protocol,omitempty"` // tcp, udp, or both
	Name      string `yaml:"name,omitempty" json:"name,omitempty"`         // logical name (ui, api, admin)
}

// BackendEndpoint is an explicit backend URL with a logical name.
type BackendEndpoint struct {
	Name string `yaml:"name" json:"name"`
	URL  string `yaml:"url" json:"url"`
}

// VolumeMapping represents a volume binding
type VolumeMapping struct {
	Name      string `yaml:"name" json:"name"`             // Named volume or path
	MountPath string `yaml:"mount_path" json:"mount_path"` // Container mount path
	ReadOnly  bool   `yaml:"read_only,omitempty" json:"read_only,omitempty"`
}

// GPUConfig contains GPU-related configuration
type GPUConfig struct {
	Supported bool   `yaml:"supported" json:"supported"`
	Required  bool   `yaml:"required" json:"required"`
	Runtime   string `yaml:"runtime,omitempty" json:"runtime,omitempty"` // nvidia, amd, etc.
}

// ConfigField represents a user-configurable field during installation
type ConfigField struct {
	Name        string      `yaml:"name" json:"name"`
	Label       string      `yaml:"label" json:"label"`
	Description string      `yaml:"description,omitempty" json:"description,omitempty"`
	Type        string      `yaml:"type" json:"type"` // string, number, boolean, password, select, port
	Default     interface{} `yaml:"default,omitempty" json:"default,omitempty"`
	Required    bool        `yaml:"required" json:"required"`
	Options     []string    `yaml:"options,omitempty" json:"options,omitempty"`       // For select type
	Validation  string      `yaml:"validation,omitempty" json:"validation,omitempty"` // Regex pattern
	EnvVar      string      `yaml:"env_var,omitempty" json:"env_var,omitempty"`       // Maps to this env var
	Advanced    bool        `yaml:"advanced,omitempty" json:"advanced,omitempty"`     // Hide behind advanced toggle
}

// HealthCheckConfig defines how to check app health
type HealthCheckConfig struct {
	Type     string        `yaml:"type" json:"type"`                             // http, tcp, container, command
	Endpoint string        `yaml:"endpoint,omitempty" json:"endpoint,omitempty"` // For http
	Port     int           `yaml:"port,omitempty" json:"port,omitempty"`         // For tcp
	Interval time.Duration `yaml:"interval" json:"interval"`
	Timeout  time.Duration `yaml:"timeout" json:"timeout"`
	Retries  int           `yaml:"retries" json:"retries"`
}

// ResourceRequirements defines minimum system requirements
type ResourceRequirements struct {
	MinRAM  string   `yaml:"min_ram,omitempty" json:"min_ram,omitempty"`   // e.g., "512M", "2G"
	MinCPU  float64  `yaml:"min_cpu,omitempty" json:"min_cpu,omitempty"`   // CPU cores
	MinDisk string   `yaml:"min_disk,omitempty" json:"min_disk,omitempty"` // e.g., "1G"
	Arch    []string `yaml:"arch,omitempty" json:"arch,omitempty"`         // amd64, arm64
}

// UpdateConfig defines update behavior
type UpdateConfig struct {
	Strategy           string `yaml:"strategy" json:"strategy"` // manual, notify, auto
	BackupBeforeUpdate bool   `yaml:"backup_before_update" json:"backup_before_update"`
}

// InstalledApp represents an app instance installed on the system
type InstalledApp struct {
	ID            string                 `json:"id"`
	AppID         string                 `json:"app_id"` // Reference to catalog app
	Name          string                 `json:"name"`
	Type          AppType                `json:"type"`
	Status        AppStatus              `json:"status"`
	HealthStatus  HealthStatus           `json:"health_status"`
	Path          string                 `json:"path"` // Installation path
	Config        map[string]interface{} `json:"config"`
	PinnedVersion string                 `json:"pinned_version,omitempty"` // If set, updates will be ignored unless to this version
	URL           string                 `json:"url,omitempty"`
	Backends      []BackendRef           `json:"backends,omitempty"`
	InstalledAt   time.Time              `json:"installed_at"`
	UpdatedAt     time.Time              `json:"updated_at"`
	LastHealthAt  time.Time              `json:"last_health_at,omitempty"`
	ContainerIDs  []string               `json:"container_ids,omitempty"`
	Error         string                 `json:"error,omitempty"` // Error message from failed install/update

	// Exposed info - merged from app definition + script output
	ExposedInfo map[string]ExposedInfoValue `json:"exposed_info,omitempty"`

	// Runtime metrics
	CPUPercent  float64 `json:"cpu_percent,omitempty"`
	MemoryUsage uint64  `json:"memory_usage,omitempty"`
	MemoryLimit uint64  `json:"memory_limit,omitempty"`

	// Uptime/Downtime (in seconds)
	Uptime   int64 `json:"uptime_seconds,omitempty"`
	Downtime int64 `json:"downtime_seconds,omitempty"`

	// Availability (0-100)
	Availability float64 `json:"availability_pct,omitempty"`

	// State tracking
	LastStartedAt time.Time `json:"last_started_at,omitempty"`
	LastStoppedAt time.Time `json:"last_stopped_at,omitempty"`

	// Version tracking
	ImageDigest        string            `json:"image_digest,omitempty"`
	ComposeTemplateSHA string            `json:"compose_template_sha,omitempty"`
	RevocationNotice   *RevocationNotice `json:"revocation_notice,omitempty"`
}

// RedactForAPI returns a shallow copy of the app with sensitive config keys
// stripped from Config. The "server" key contains SMTP passwords, tunnel
// tokens, and other server secrets; "_compose_template_sha" is internal state.
// Top-level secret keys (see secretConfigKeys, e.g. oidc_client_secret) are
// also stripped. This must stay aligned with stripServerContext.
// This should be called before serializing an InstalledApp for API responses.
func (a *InstalledApp) RedactForAPI() *InstalledApp {
	if a == nil {
		return nil
	}
	redacted := *a
	if a.Config != nil {
		redacted.Config = make(map[string]interface{}, len(a.Config))
		for k, v := range a.Config {
			if k == "server" || k == "_compose_template_sha" {
				continue
			}
			if _, secret := secretConfigKeys[k]; secret {
				continue
			}
			redacted.Config[k] = v
		}
	}
	return &redacted
}

type RevocationNotice struct {
	Severity       string     `json:"severity"`
	Reason         string     `json:"reason"`
	RevokedAt      time.Time  `json:"revoked_at"`
	AcknowledgedAt *time.Time `json:"acknowledged_at,omitempty"`
}

// BackendRef describes a reachable backend for an installed app.
type BackendRef struct {
	Name string `json:"name,omitempty"` // logical name (ui, api, admin)
	URL  string `json:"url"`            // reachable URL
}

// AppStatus represents the current status of an installed app
type AppStatus string

// AppStatus values for installed app state.
const (
	StatusPending    AppStatus = "pending"
	StatusInstalling AppStatus = "installing"
	StatusRunning    AppStatus = "running"
	StatusStopped    AppStatus = "stopped"
	StatusUpdating   AppStatus = "updating"
	StatusError      AppStatus = "error"
	StatusRemoving   AppStatus = "removing"
	StatusRevoked    AppStatus = "revoked"
)

// HealthStatus represents the health status of an app
type HealthStatus string

// HealthStatus values for health checks.
const (
	HealthUnknown   HealthStatus = "unknown"
	HealthHealthy   HealthStatus = "healthy"
	HealthUnhealthy HealthStatus = "unhealthy"
	HealthDegraded  HealthStatus = "degraded"
)

// AppUpdate represents an update record in history
type AppUpdate struct {
	ID          int64      `json:"id"`
	AppID       string     `json:"app_id"`
	Status      string     `json:"status"` // pending, success, failed, rolled_back
	OldVersion  string     `json:"old_version"`
	NewVersion  string     `json:"new_version"`
	StartedAt   time.Time  `json:"started_at"`
	CompletedAt *time.Time `json:"completed_at,omitempty"`
	Error       string     `json:"error,omitempty"`
	RolledBack  bool       `json:"rolled_back"`
	BackupID    string     `json:"backup_id,omitempty"`
}

// AvailableUpdate represents an available update for an installed app
type AvailableUpdate struct {
	InstanceID             string `json:"instance_id"`
	AppID                  string `json:"app_id"`
	AppName                string `json:"app_name"`
	CurrentVersion         string `json:"current_version"`
	LatestVersion          string `json:"latest_version"`
	CurrentDigest          string `json:"current_digest,omitempty"`
	LatestDigest           string `json:"latest_digest,omitempty"`
	ComposeTemplateChanged bool   `json:"compose_template_changed"`
	NeedsConfig            bool   `json:"needs_config"`
	NeedsConfigReason      string `json:"needs_config_reason,omitempty"`
	IsUpdate               bool   `json:"is_update"`
	DigestTrackingEnabled  bool   `json:"digest_tracking_enabled"`
}

type ScriptConfig struct {
	System  SystemScripts  `yaml:"system,omitempty" json:"system,omitempty"`
	Actions []ScriptAction `yaml:"actions,omitempty" json:"actions,omitempty"`
}

type SystemScripts struct {
	Setup             string                  `yaml:"setup,omitempty" json:"setup,omitempty"`
	Update            string                  `yaml:"update,omitempty" json:"update,omitempty"`
	Repair            string                  `yaml:"repair,omitempty" json:"repair,omitempty"`
	DestructiveRepair DestructiveRepairConfig `yaml:"destructive_repair,omitempty" json:"destructive_repair,omitempty"`
}

// DestructiveRepairConfig declares a destructive repair script and its
// user-facing description so the UI can explain what will be destroyed.
type DestructiveRepairConfig struct {
	Script      string `yaml:"script" json:"script"`
	Description string `yaml:"description,omitempty" json:"description,omitempty"`
}

type ScriptAction struct {
	Name        string          `yaml:"name" json:"name"`
	Label       string          `yaml:"label" json:"label"`
	Description string          `yaml:"description,omitempty" json:"description,omitempty"`
	Script      string          `yaml:"script" json:"script"`
	Icon        string          `yaml:"icon,omitempty" json:"icon,omitempty"`
	Confirm     ActionConfirm   `yaml:"confirm,omitempty" json:"confirm,omitempty"`
	Options     []ScriptOption  `yaml:"options,omitempty" json:"options,omitempty"`
	Execution   ScriptExecution `yaml:"execution,omitempty" json:"execution,omitempty"`
}

type ActionConfirm struct {
	Enabled  bool   `yaml:"enabled" json:"enabled"`
	Message  string `yaml:"message,omitempty" json:"message,omitempty"`
	Typename string `yaml:"type,omitempty" json:"type,omitempty"`
}

type ScriptOption struct {
	Name        string        `yaml:"name" json:"name"`
	Label       string        `yaml:"label" json:"label"`
	Description string        `yaml:"description,omitempty" json:"description,omitempty"`
	Type        string        `yaml:"type" json:"type"`
	Default     interface{}   `yaml:"default,omitempty" json:"default,omitempty"`
	Required    bool          `yaml:"required" json:"required"`
	Options     []OptionValue `yaml:"options,omitempty" json:"options,omitempty"`
	Validation  string        `yaml:"validation,omitempty" json:"validation,omitempty"`
	Min         interface{}   `yaml:"min,omitempty" json:"min,omitempty"`
	Max         interface{}   `yaml:"max,omitempty" json:"max,omitempty"`
	Secret      bool          `yaml:"secret,omitempty" json:"secret,omitempty"`
}

type OptionValue struct {
	Value string `yaml:"value" json:"value"`
	Label string `yaml:"label,omitempty" json:"label,omitempty"`
}

type ScriptExecution struct {
	Timeout      int    `yaml:"timeout,omitempty" json:"timeout,omitempty"`
	WorkingDir   string `yaml:"working_dir,omitempty" json:"working_dir,omitempty"`
	User         string `yaml:"user,omitempty" json:"user,omitempty"`
	StreamOutput bool   `yaml:"stream_output,omitempty" json:"stream_output,omitempty"`
}

type ScriptResult struct {
	Success     bool                   `json:"success"`
	ExitCode    int                    `json:"exit_code"`
	Output      string                 `json:"output,omitempty"`
	Error       string                 `json:"error,omitempty"`
	Duration    time.Duration          `json:"duration"`
	Data        map[string]interface{} `json:"data,omitempty"`
	ExposedInfo map[string]interface{} `json:"exposed_info,omitempty"`
}

type ScriptExecutionRequest struct {
	InstanceID string                 `json:"instance_id"`
	Script     string                 `json:"script"`
	Options    map[string]interface{} `json:"options,omitempty"`
}

type ScriptExecutionResponse struct {
	ExecutionID string        `json:"execution_id"`
	Result      *ScriptResult `json:"result,omitempty"`
	StreamURL   string        `json:"stream_url,omitempty"`
}

type ServerContext struct {
	ServerPort     int    `json:"server_port" yaml:"server_port"`
	ServerMode     string `json:"server_mode" yaml:"server_mode"`
	ServerHost     string `json:"server_host" yaml:"server_host"`
	ServerURL      string `json:"server_url" yaml:"server_url"`
	DefaultDomain  string `json:"default_domain" yaml:"default_domain"`
	CaddyMode      string `json:"caddy_mode" yaml:"caddy_mode"`
	ACMEEmail      string `json:"acme_email" yaml:"acme_email"`
	SMTPHost       string `json:"smtp_host" yaml:"smtp_host"`
	SMTPPort       int    `json:"smtp_port" yaml:"smtp_port"`
	SMTPUsername   string `json:"smtp_username" yaml:"smtp_username"`
	SMTPPassword   string `json:"smtp_password" yaml:"smtp_password"`
	SMTPFrom       string `json:"smtp_from" yaml:"smtp_from"`
	SMTPUseTLS     bool   `json:"smtp_use_tls" yaml:"smtp_use_tls"`
	SMTPSkipVerify bool   `json:"smtp_skip_verify" yaml:"smtp_skip_verify"`
	TunnelEnabled  bool   `json:"tunnel_enabled" yaml:"tunnel_enabled"`
	TunnelProvider string `json:"tunnel_provider" yaml:"tunnel_provider"`
	TunnelToken    string `json:"tunnel_token" yaml:"tunnel_token"`
	DNSProvider    string `json:"dns_provider" yaml:"dns_provider"`
}

func NewServerContext(cfg ServerContextConfig) ServerContext {
	scheme := "http"
	if cfg.CaddyMode == "enabled" && cfg.DefaultDomain != "" {
		scheme = "https"
	}
	host := cfg.DefaultDomain
	if host == "" {
		host = cfg.ServerHost
		if host == "0.0.0.0" || host == "127.0.0.1" || host == "" {
			host = "localhost"
		}
	}
	port := cfg.ServerPort
	serverURL := fmt.Sprintf("%s://%s", scheme, host)
	if (scheme == "http" && port != 80) || (scheme == "https" && port != 443) {
		serverURL = fmt.Sprintf("%s:%d", serverURL, port)
	}

	return ServerContext{
		ServerPort:     cfg.ServerPort,
		ServerMode:     cfg.ServerMode,
		ServerHost:     cfg.ServerHost,
		ServerURL:      serverURL,
		DefaultDomain:  cfg.DefaultDomain,
		CaddyMode:      cfg.CaddyMode,
		ACMEEmail:      cfg.ACMEEmail,
		SMTPHost:       cfg.SMTPHost,
		SMTPPort:       cfg.SMTPPort,
		SMTPUsername:   cfg.SMTPUsername,
		SMTPPassword:   cfg.SMTPPassword,
		SMTPFrom:       cfg.SMTPFrom,
		SMTPUseTLS:     cfg.SMTPUseTLS,
		SMTPSkipVerify: cfg.SMTPSkipVerify,
		TunnelEnabled:  cfg.TunnelEnabled,
		TunnelProvider: cfg.TunnelProvider,
		TunnelToken:    cfg.TunnelToken,
		DNSProvider:    cfg.DNSProvider,
	}
}

type ServerContextConfig struct {
	ServerPort     int
	ServerMode     string
	ServerHost     string
	DefaultDomain  string
	CaddyMode      string
	ACMEEmail      string
	SMTPHost       string
	SMTPPort       int
	SMTPUsername   string
	SMTPPassword   string
	SMTPFrom       string
	SMTPUseTLS     bool
	SMTPSkipVerify bool
	TunnelEnabled  bool
	TunnelProvider string
	TunnelToken    string
	DNSProvider    string
}

type ScriptExecutionConfig struct {
	InstanceID  string                 `json:"instance_id"`
	AppID       string                 `json:"app_id"`
	InstallPath string                 `json:"install_path"`
	AppDataPath string                 `json:"app_data_path"`
	ConfigPath  string                 `json:"config_path"`
	ConfigDir   string                 `json:"config_dir"`
	Runtime     RuntimeInfo            `json:"runtime"`
	Server      ServerContext          `json:"server"`
	Options     map[string]interface{} `json:"options"`
}

type RuntimeInfo struct {
	ComposeFile string `json:"compose_file"`
	ProjectName string `json:"project_name"`
}

// AccessModel defines how LibreServ handles authentication for an app.
//
// "internal" — LibreServ is the OIDC Identity Provider. The app authenticates
// users via OIDC against LibreServ's user store. Access is controlled by
// LibreServ user permissions. App must support OIDC (e.g. Nextcloud).
//
// "external" — LibreServ just reverse-proxies. The app manages its own auth
// entirely. LibreServ does not gate access or propagate identity.
type AccessModel string

const (
	AccessModelInternal AccessModel = "internal"
	AccessModelExternal AccessModel = "external"
)

// ToNetworkRequirement adapts this Access schema into the network decision
// engine's boundary type. Defined here (apps already imports network) so the
// engine stays decoupled from the catalog.
func (a Access) ToNetworkRequirement() network.Requirement {
	req := network.Requirement{
		Web:          a.Web,
		LargeUploads: a.LargeUploads,
	}
	for _, p := range a.Ports {
		req.Ports = append(req.Ports, network.PortNeed{
			Protocol:   p.Protocol,
			Port:       p.Port,
			VerifyHint: p.VerifyHint,
		})
	}
	return req
}
