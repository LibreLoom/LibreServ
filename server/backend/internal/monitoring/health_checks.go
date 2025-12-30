package monitoring

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/docker/docker/api/types"
	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
)

// HTTPCheck performs HTTP health checks
type HTTPCheck struct {
	Config     HTTPCheckConfig
	httpClient *http.Client
}

// NewHTTPCheck creates an HTTP health check with a timeout.
func NewHTTPCheck(cfg HTTPCheckConfig, timeout time.Duration) *HTTPCheck {
	return &HTTPCheck{
		Config: cfg,
		httpClient: &http.Client{
			Timeout: timeout,
		},
	}
}

// Type returns the check type.
func (h *HTTPCheck) Type() string {
	return "http"
}

// Run executes the HTTP check.
func (h *HTTPCheck) Run(ctx context.Context) CheckResult {
	result := CheckResult{
		CheckType: h.Type(),
		Timestamp: time.Now(),
	}

	method := h.Config.Method
	if method == "" {
		method = "GET"
	}

	req, err := http.NewRequestWithContext(ctx, method, h.Config.URL, nil)
	if err != nil {
		result.Status = HealthStatusUnhealthy
		result.Message = fmt.Sprintf("Failed to create request: %v", err)
		return result
	}

	// Add custom headers
	for key, value := range h.Config.Headers {
		req.Header.Set(key, value)
	}

	resp, err := h.httpClient.Do(req)
	if err != nil {
		result.Status = HealthStatusUnhealthy
		result.Message = fmt.Sprintf("Request failed: %v", err)
		return result
	}
	defer resp.Body.Close()

	// Check status code
	expectedStatus := h.Config.ExpectedStatus
	if expectedStatus == 0 {
		expectedStatus = 200
	}

	if resp.StatusCode != expectedStatus {
		result.Status = HealthStatusUnhealthy
		result.Message = fmt.Sprintf("Expected status %d, got %d", expectedStatus, resp.StatusCode)
		return result
	}

	result.Status = HealthStatusHealthy
	result.Message = fmt.Sprintf("HTTP check passed (status: %d)", resp.StatusCode)
	return result
}

// TCPCheck performs TCP connection health checks
type TCPCheck struct {
	Config  TCPCheckConfig
	Timeout time.Duration
}

// NewTCPCheck creates a TCP health check with a timeout.
func NewTCPCheck(cfg TCPCheckConfig, timeout time.Duration) *TCPCheck {
	return &TCPCheck{
		Config:  cfg,
		Timeout: timeout,
	}
}

// Type returns the check type.
func (t *TCPCheck) Type() string {
	return "tcp"
}

// Run executes the TCP check.
func (t *TCPCheck) Run(ctx context.Context) CheckResult {
	result := CheckResult{
		CheckType: t.Type(),
		Timestamp: time.Now(),
	}

	address := fmt.Sprintf("%s:%d", t.Config.Host, t.Config.Port)

	dialer := &net.Dialer{
		Timeout: t.Timeout,
	}

	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		result.Status = HealthStatusUnhealthy
		result.Message = fmt.Sprintf("TCP connection failed: %v", err)
		return result
	}
	conn.Close()

	result.Status = HealthStatusHealthy
	result.Message = fmt.Sprintf("TCP check passed (%s)", address)
	return result
}

// ContainerCheck verifies Docker container health status
type ContainerCheck struct {
	Config       ContainerCheckConfig
	DockerClient *client.Client
}

// NewContainerCheck creates a container health check.
func NewContainerCheck(cfg ContainerCheckConfig, dockerClient *client.Client) *ContainerCheck {
	return &ContainerCheck{
		Config:       cfg,
		DockerClient: dockerClient,
	}
}

// Type returns the check type.
func (c *ContainerCheck) Type() string {
	return "container"
}

// Run executes the container health check.
func (c *ContainerCheck) Run(ctx context.Context) CheckResult {
	result := CheckResult{
		CheckType: c.Type(),
		Timestamp: time.Now(),
	}

	if c.DockerClient == nil {
		result.Status = HealthStatusDegraded
		result.Message = "Docker unavailable; container health checks are disabled"
		return result
	}

	// List containers to find the one matching our name
	containers, err := c.DockerClient.ContainerList(ctx, container.ListOptions{All: true})
	if err != nil {
		result.Status = HealthStatusUnknown
		result.Message = fmt.Sprintf("Failed to list containers: %v", err)
		return result
	}

	targetContainer := pickContainer(containers, c.Config.ContainerName)

	if targetContainer == nil {
		result.Status = HealthStatusUnhealthy
		result.Message = fmt.Sprintf("Container '%s' not found", c.Config.ContainerName)
		return result
	}

	// Check container state
	state := strings.ToLower(targetContainer.State)
	switch state {
	case "running":
		// Check if container has a health check configured
		inspect, err := c.DockerClient.ContainerInspect(ctx, targetContainer.ID)
		if err != nil {
			result.Status = HealthStatusHealthy
			result.Message = "Container is running (health details unavailable)"
			return result
		}

		if inspect.State.Health != nil {
			switch inspect.State.Health.Status {
			case "healthy":
				result.Status = HealthStatusHealthy
				result.Message = "Container is healthy"
			case "unhealthy":
				result.Status = HealthStatusUnhealthy
				result.Message = "Container health check reports unhealthy"
			case "starting":
				result.Status = HealthStatusUnknown
				result.Message = "Container health check is starting"
			default:
				result.Status = HealthStatusHealthy
				result.Message = "Container is running"
			}
		} else {
			result.Status = HealthStatusHealthy
			result.Message = "Container is running (no health check configured)"
		}

	case "exited", "dead":
		result.Status = HealthStatusUnhealthy
		result.Message = fmt.Sprintf("Container is %s", state)

	case "paused":
		result.Status = HealthStatusDegraded
		result.Message = "Container is paused"

	case "restarting":
		result.Status = HealthStatusDegraded
		result.Message = "Container is restarting"

	default:
		result.Status = HealthStatusUnknown
		result.Message = fmt.Sprintf("Unknown container state: %s", state)
	}

	return result
}

func pickContainer(containers []types.Container, query string) *types.Container {
	if query == "" {
		return nil
	}

	// Prefer label-based matching (compose projects/services, LibreServ label), and prefer a running container.
	var bestLabelMatch *types.Container
	for i := range containers {
		cont := &containers[i]
		if !matchesContainerByLabels(*cont, query) {
			continue
		}
		if strings.EqualFold(cont.State, "running") {
			return cont
		}
		if bestLabelMatch == nil {
			bestLabelMatch = cont
		}
	}
	if bestLabelMatch != nil {
		return bestLabelMatch
	}

	// Fallback: match by container name.
	var bestNameMatch *types.Container
	for i := range containers {
		cont := &containers[i]
		if !matchesContainerByName(*cont, query) {
			continue
		}
		if strings.EqualFold(cont.State, "running") {
			return cont
		}
		if bestNameMatch == nil {
			bestNameMatch = cont
		}
	}
	return bestNameMatch
}

func matchesContainerByLabels(cont types.Container, query string) bool {
	if query == "" {
		return false
	}
	if cont.Labels == nil {
		return false
	}
	if cont.Labels["com.docker.compose.project"] == query {
		return true
	}
	if cont.Labels["com.docker.compose.service"] == query {
		return true
	}
	if cont.Labels["libreserv.app"] == query {
		return true
	}
	return false
}

func matchesContainerByName(cont types.Container, query string) bool {
	if query == "" {
		return false
	}
	for _, name := range cont.Names {
		// Container names are prefixed with /
		cleanName := strings.TrimPrefix(name, "/")
		if cleanName == query || strings.Contains(cleanName, query) {
			return true
		}
	}
	return false
}

// CompositeCheck runs multiple checks and aggregates results
type CompositeCheck struct {
	Checks []Check
}

// NewCompositeCheck builds a composite health check.
func NewCompositeCheck(checks ...Check) *CompositeCheck {
	return &CompositeCheck{Checks: checks}
}

// Type returns the check type.
func (c *CompositeCheck) Type() string {
	return "composite"
}

// Run executes all checks and aggregates results.
func (c *CompositeCheck) Run(ctx context.Context) CheckResult {
	result := CheckResult{
		CheckType: c.Type(),
		Timestamp: time.Now(),
	}

	if len(c.Checks) == 0 {
		result.Status = HealthStatusUnknown
		result.Message = "No checks configured"
		return result
	}

	var healthy, unhealthy, degraded, unknown int
	var messages []string

	for _, check := range c.Checks {
		r := check.Run(ctx)
		messages = append(messages, fmt.Sprintf("%s: %s", check.Type(), r.Message))

		switch r.Status {
		case HealthStatusHealthy:
			healthy++
		case HealthStatusUnhealthy:
			unhealthy++
		case HealthStatusDegraded:
			degraded++
		default:
			unknown++
		}
	}

	// Determine overall status
	if unhealthy > 0 {
		result.Status = HealthStatusUnhealthy
	} else if degraded > 0 || unknown > 0 {
		result.Status = HealthStatusDegraded
	} else {
		result.Status = HealthStatusHealthy
	}

	result.Message = strings.Join(messages, "; ")
	return result
}
