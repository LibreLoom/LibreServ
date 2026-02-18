package apps

import "time"

// AppType represents the type of app in the catalog
type AppType string

const (
	// AppTypeBuiltin represents apps from the official catalog
	AppTypeBuiltin AppType = "builtin"
	// AppTypeCustom represents user-uploaded compose files
	AppTypeCustom AppType = "custom"
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

// AppDefinition represents a complete app definition in the catalog
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

	// User-configurable fields shown during installation
	Configuration []ConfigField `yaml:"configuration" json:"configuration"`

	// Health check configuration
	HealthCheck HealthCheckConfig `yaml:"health_check" json:"health_check"`

	// Resource requirements
	Requirements ResourceRequirements `yaml:"requirements" json:"requirements"`

	// Update configuration
	Updates UpdateConfig `yaml:"updates" json:"updates"`

	// Script configuration
	Scripts ScriptConfig `yaml:"scripts,omitempty" json:"scripts,omitempty"`

	// App features and capabilities (Feature Matrix v2)
	Features AppFeatures `yaml:"features,omitempty" json:"features,omitempty"`

	// Internal metadata (not from YAML)
	Type        AppType `yaml:"-" json:"type"`
	CatalogPath string  `yaml:"-" json:"-"`
}

type AppFeatures struct {
	// Basic app flags (backward compatible)
	ReadOnly      bool     `yaml:"read_only,omitempty" json:"read_only,omitempty"`
	NoUninstall   bool     `yaml:"no_uninstall,omitempty" json:"no_uninstall,omitempty"`
	Experimental  bool     `yaml:"experimental,omitempty" json:"experimental,omitempty"`
	RequiresRoot  bool     `yaml:"requires_root,omitempty" json:"requires_root,omitempty"`
	RequiresGPU   bool     `yaml:"requires_gpu,omitempty" json:"requires_gpu,omitempty"`
	SupportedOS   []string `yaml:"supported_os,omitempty" json:"supported_os,omitempty"`
	UnsupportedOS []string `yaml:"unsupported_os,omitempty" json:"unsupported_os,omitempty"`
	MinRAM        int      `yaml:"min_ram,omitempty" json:"min_ram,omitempty"`
	MinCPU        int      `yaml:"min_cpu,omitempty" json:"min_cpu,omitempty"`

	// Feature Matrix (v2 design)
	AccessModel    AccessModel    `yaml:"access_model,omitempty" json:"access_model,omitempty"`
	Backup         FeatureSupport `yaml:"backup,omitempty" json:"backup,omitempty"`
	UpdateBehavior UpdateBehavior `yaml:"update_behavior,omitempty" json:"update_behavior,omitempty"`
	SSO            bool           `yaml:"sso,omitempty" json:"sso,omitempty"`
	CustomDomains  bool           `yaml:"custom_domains,omitempty" json:"custom_domains,omitempty"`
	ResourceHints  ResourceHints  `yaml:"resource_hints,omitempty" json:"resource_hints,omitempty"`
}

// DeploymentConfig contains Docker deployment settings
type DeploymentConfig struct {
	// ComposeFile is the path to docker-compose.yml template relative to app directory
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
	AllowDowngrade     bool   `yaml:"allow_downgrade" json:"allow_downgrade"`
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
	InstanceID     string `json:"instance_id"`
	AppID          string `json:"app_id"`
	AppName        string `json:"app_name"`
	CurrentVersion string `json:"current_version"`
	LatestVersion  string `json:"latest_version"`
	IsUpdate       bool   `json:"is_update"`
}

type ScriptConfig struct {
	System  SystemScripts  `yaml:"system,omitempty" json:"system,omitempty"`
	Actions []ScriptAction `yaml:"actions,omitempty" json:"actions,omitempty"`
}

type SystemScripts struct {
	Setup             string `yaml:"setup,omitempty" json:"setup,omitempty"`
	Update            string `yaml:"update,omitempty" json:"update,omitempty"`
	Repair            string `yaml:"repair,omitempty" json:"repair,omitempty"`
	DestructiveRepair string `yaml:"destructive_repair,omitempty" json:"destructive_repair,omitempty"`
	Backup            string `yaml:"backup,omitempty" json:"backup,omitempty"`
	Restore           string `yaml:"restore,omitempty" json:"restore,omitempty"`
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
	Success  bool                   `json:"success"`
	ExitCode int                    `json:"exit_code"`
	Output   string                 `json:"output,omitempty"`
	Error    string                 `json:"error,omitempty"`
	Duration time.Duration          `json:"duration"`
	Data     map[string]interface{} `json:"data,omitempty"`
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

type ScriptExecutionConfig struct {
	InstanceID  string                 `json:"instance_id"`
	AppID       string                 `json:"app_id"`
	InstallPath string                 `json:"install_path"`
	AppDataPath string                 `json:"app_data_path"`
	ConfigPath  string                 `json:"config_path"`
	Runtime     RuntimeInfo            `json:"runtime"`
	Options     map[string]interface{} `json:"options"`
}

type RuntimeInfo struct {
	ComposeFile string `json:"compose_file"`
	ProjectName string `json:"project_name"`
}

// AccessModel defines how users access this app
type AccessModel string

const (
	AccessModelSharedAccount   AccessModel = "shared_account"
	AccessModelIntegratedUsers AccessModel = "integrated_users"
	AccessModelExternalAuth    AccessModel = "external_auth"
	AccessModelPublic          AccessModel = "public"
)

// FeatureSupport indicates whether a feature is supported
type FeatureSupport string

const (
	FeatureSupported   FeatureSupport = "supported"
	FeatureUnsupported FeatureSupport = "not_supported"
)

// UpdateBehavior describes how updates work for this app
type UpdateBehavior struct {
	Automatic        bool `yaml:"automatic" json:"automatic"`
	RequiresDowntime bool `yaml:"requires_downtime" json:"requires_downtime"`
	SupportsRollback bool `yaml:"supports_rollback" json:"supports_rollback"`
}

// ResourceHints provides hints about resource requirements
type ResourceHints struct {
	SingleInstance     bool `yaml:"single_instance,omitempty" json:"single_instance,omitempty"`
	PrivilegedRequired bool `yaml:"privileged_required,omitempty" json:"privileged_required,omitempty"`
}

// GetDefaultFeatures returns the default feature set for apps that don't declare features
func GetDefaultFeatures() AppFeatures {
	return AppFeatures{
		AccessModel: AccessModelIntegratedUsers,
		Backup:      FeatureSupported,
		UpdateBehavior: UpdateBehavior{
			Automatic:        false,
			RequiresDowntime: true,
			SupportsRollback: false,
		},
		SSO:           true,
		CustomDomains: true,
		ResourceHints: ResourceHints{
			SingleInstance:     false,
			PrivilegedRequired: false,
		},
	}
}
