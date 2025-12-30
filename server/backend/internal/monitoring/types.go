package monitoring

import (
	"context"
	"time"
)

// HealthStatus represents the health state of an app
type HealthStatus string

// HealthStatus values used by monitoring checks.
const (
	HealthStatusHealthy   HealthStatus = "healthy"
	HealthStatusUnhealthy HealthStatus = "unhealthy"
	HealthStatusDegraded  HealthStatus = "degraded"
	HealthStatusUnknown   HealthStatus = "unknown"
)

// CheckResult represents the result of a health check
type CheckResult struct {
	Status    HealthStatus `json:"status"`
	Message   string       `json:"message"`
	CheckType string       `json:"check_type"`
	Timestamp time.Time    `json:"timestamp"`
}

// Check is the interface for health check implementations
type Check interface {
	Run(ctx context.Context) CheckResult
	Type() string
}

// HealthCheckConfig defines how to check an app's health
type HealthCheckConfig struct {
	// HTTP health check
	HTTP *HTTPCheckConfig `yaml:"http,omitempty" json:"http,omitempty"`
	// TCP health check
	TCP *TCPCheckConfig `yaml:"tcp,omitempty" json:"tcp,omitempty"`
	// Container health check (relies on Docker)
	Container *ContainerCheckConfig `yaml:"container,omitempty" json:"container,omitempty"`
	// Command health check
	Command *CommandCheckConfig `yaml:"command,omitempty" json:"command,omitempty"`
	// Check interval
	Interval time.Duration `yaml:"interval" json:"interval"`
	// Timeout for each check
	Timeout time.Duration `yaml:"timeout" json:"timeout"`
	// Number of consecutive failures before marking unhealthy
	FailureThreshold int `yaml:"failure_threshold" json:"failure_threshold"`
	// Number of consecutive successes before marking healthy
	SuccessThreshold int `yaml:"success_threshold" json:"success_threshold"`
}

// HTTPCheckConfig configures an HTTP health check
type HTTPCheckConfig struct {
	URL            string            `yaml:"url" json:"url"`
	Method         string            `yaml:"method" json:"method"`
	Headers        map[string]string `yaml:"headers,omitempty" json:"headers,omitempty"`
	ExpectedStatus int               `yaml:"expected_status" json:"expected_status"`
	ExpectedBody   string            `yaml:"expected_body,omitempty" json:"expected_body,omitempty"`
}

// TCPCheckConfig configures a TCP health check
type TCPCheckConfig struct {
	Host string `yaml:"host" json:"host"`
	Port int    `yaml:"port" json:"port"`
}

// ContainerCheckConfig configures a container health check
type ContainerCheckConfig struct {
	ContainerName string `yaml:"container_name" json:"container_name"`
}

// CommandCheckConfig configures a command-based health check
type CommandCheckConfig struct {
	Command string   `yaml:"command" json:"command"`
	Args    []string `yaml:"args,omitempty" json:"args,omitempty"`
}

// Metrics represents resource usage metrics for an app
type Metrics struct {
	AppID       string    `json:"app_id"`
	Timestamp   time.Time `json:"timestamp"`
	CPUPercent  float64   `json:"cpu_percent"`
	MemoryUsage uint64    `json:"memory_usage"`
	MemoryLimit uint64    `json:"memory_limit"`
	NetworkRx   uint64    `json:"network_rx"`
	NetworkTx   uint64    `json:"network_tx"`
}

// HealthCheckRecord is a database record of a health check
type HealthCheckRecord struct {
	ID        int64     `json:"id"`
	AppID     string    `json:"app_id"`
	CheckType string    `json:"check_type"`
	Status    string    `json:"status"`
	Message   string    `json:"message"`
	CheckedAt time.Time `json:"checked_at"`
}

// AppHealth provides a summary of an app's health
type AppHealth struct {
	AppID          string        `json:"app_id"`
	Status         HealthStatus  `json:"status"`
	LastCheck      *time.Time    `json:"last_check,omitempty"`
	RecentChecks   []CheckResult `json:"recent_checks,omitempty"`
	CurrentMetrics *Metrics      `json:"current_metrics,omitempty"`
	Message        string        `json:"message,omitempty"`
}
