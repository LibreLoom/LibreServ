package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
)

func DockerTools(dockerClient *docker.Client) []*Tool {
	if dockerClient == nil {
		return nil
	}

	return []*Tool{
		{
			Name:        "docker_ps",
			Description: "List all Docker containers and their status (running, stopped, healthy, unhealthy).",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"all": {"type": "boolean", "description": "Include stopped containers", "default": true}
				}
			}`),
			IsResearch:         true,
			RequiresPermission: false,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				containers, err := dockerClient.ListContainersAll(ctx)
				if err != nil {
					return "", fmt.Errorf("unable to list containers: %w", err)
				}
				type containerInfo struct {
					ID     string   `json:"id"`
					Names  []string `json:"names"`
					Image  string   `json:"image"`
					State  string   `json:"state"`
					Status string   `json:"status"`
				}
				var info []containerInfo
				for _, c := range containers {
					info = append(info, containerInfo{
						ID:     c.ID,
						Names:  c.Names,
						Image:  c.Image,
						State:  string(c.State),
						Status: c.Status,
					})
				}
				data, _ := json.MarshalIndent(info, "", "  ")
				return string(data), nil
			},
		},
		{
			Name:        "docker_logs",
			Description: "Get recent logs from a Docker container. Use this to diagnose errors or check application output.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"container": {"type": "string", "description": "Container name or ID"},
					"tail": {"type": "string", "description": "Number of lines to return from the end", "default": "50"}
				},
				"required": ["container"]
			}`),
			IsResearch:         true,
			RequiresPermission: false,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				var params struct {
					Container string `json:"container"`
					Tail      string `json:"tail"`
				}
				if err := json.Unmarshal(args, &params); err != nil {
					return "", fmt.Errorf("invalid arguments: %w", err)
				}
				if params.Container == "" {
					return "", fmt.Errorf("container name is required")
				}
				if params.Tail == "" {
					params.Tail = "50"
				}
				reader, err := dockerClient.ContainerLogs(ctx, params.Container, false, params.Tail)
				if err != nil {
					return "", fmt.Errorf("unable to get logs for %s: %w", params.Container, err)
				}
				defer reader.Close()
				data, err := io.ReadAll(reader)
				if err != nil {
					return "", fmt.Errorf("unable to read logs: %w", err)
				}
				return string(data), nil
			},
		},
		{
			Name:        "docker_inspect",
			Description: "Get detailed information about a Docker container. Environment variables are redacted for security.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"container": {"type": "string", "description": "Container name or ID"}
				},
				"required": ["container"]
			}`),
			IsResearch:         true,
			RequiresPermission: false,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				var params struct {
					Container string `json:"container"`
				}
				if err := json.Unmarshal(args, &params); err != nil {
					return "", fmt.Errorf("invalid arguments: %w", err)
				}
				if params.Container == "" {
					return "", fmt.Errorf("container name is required")
				}
				result, err := dockerClient.InspectContainer(ctx, params.Container)
				if err != nil {
					return "", fmt.Errorf("unable to inspect %s: %w", params.Container, err)
				}
				var parsed map[string]interface{}
				if err := json.Unmarshal(result.Raw, &parsed); err != nil {
					return string(result.Raw), nil
				}
				redactSensitiveFields(parsed)
				data, _ := json.MarshalIndent(parsed, "", "  ")
				return string(data), nil
			},
		},
		{
			Name:        "docker_restart",
			Description: "Restart a Docker container. Use this when an app is stuck or needs a fresh start.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"container": {"type": "string", "description": "Container name or ID"},
					"timeout": {"type": "integer", "description": "Seconds to wait before killing", "default": 10}
				},
				"required": ["container"]
			}`),
			IsResearch:         false,
			RequiresPermission: false,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				var params struct {
					Container string `json:"container"`
					Timeout   int    `json:"timeout"`
				}
				if err := json.Unmarshal(args, &params); err != nil {
					return "", fmt.Errorf("invalid arguments: %w", err)
				}
				if params.Container == "" {
					return "", fmt.Errorf("container name is required")
				}
				if params.Timeout <= 0 {
					params.Timeout = 10
				}
				timeout := time.Duration(params.Timeout) * time.Second
				if err := dockerClient.RestartContainer(ctx, params.Container, timeout); err != nil {
					return "", fmt.Errorf("unable to restart %s: %w", params.Container, err)
				}
				return fmt.Sprintf("Container %s restarted successfully", params.Container), nil
			},
		},
		{
			Name:        "docker_stop",
			Description: "Stop a running Docker container.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"container": {"type": "string", "description": "Container name or ID"}
				},
				"required": ["container"]
			}`),
			IsResearch:         false,
			RequiresPermission: false,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				var params struct {
					Container string `json:"container"`
				}
				if err := json.Unmarshal(args, &params); err != nil {
					return "", fmt.Errorf("invalid arguments: %w", err)
				}
				if params.Container == "" {
					return "", fmt.Errorf("container name is required")
				}
				if err := dockerClient.StopContainer(ctx, params.Container); err != nil {
					return "", fmt.Errorf("unable to stop %s: %w", params.Container, err)
				}
				return fmt.Sprintf("Container %s stopped", params.Container), nil
			},
		},
		{
			Name:        "docker_start",
			Description: "Start a stopped Docker container.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"container": {"type": "string", "description": "Container name or ID"}
				},
				"required": ["container"]
			}`),
			IsResearch:         false,
			RequiresPermission: false,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				var params struct {
					Container string `json:"container"`
				}
				if err := json.Unmarshal(args, &params); err != nil {
					return "", fmt.Errorf("invalid arguments: %w", err)
				}
				if params.Container == "" {
					return "", fmt.Errorf("container name is required")
				}
				if err := dockerClient.StartContainer(ctx, params.Container); err != nil {
					return "", fmt.Errorf("unable to start %s: %w", params.Container, err)
				}
				return fmt.Sprintf("Container %s started", params.Container), nil
			},
		},
	}
}

func redactSensitiveFields(parsed map[string]interface{}) {
	if config, ok := parsed["Config"].(map[string]interface{}); ok {
		config["Env"] = "[REDACTED: contains secrets]"
		if _, hasLabels := config["Labels"]; hasLabels {
			redactMapValues(config, "Labels")
		}
	}
	if hostConfig, ok := parsed["HostConfig"].(map[string]interface{}); ok {
		if binds, ok := hostConfig["Binds"].([]interface{}); ok {
			redacted := make([]string, len(binds))
			for i := range binds {
				redacted[i] = "[REDACTED: may contain credentials in mount paths]"
			}
			hostConfig["Binds"] = redacted
		}
		if _, hasLabels := hostConfig["Labels"]; hasLabels {
			redactMapValues(hostConfig, "Labels")
		}
	}
	if netSettings, ok := parsed["NetworkSettings"].(map[string]interface{}); ok {
		if ports, ok := netSettings["Ports"].(map[string]interface{}); ok {
			for key := range ports {
				ports[key] = "[REDACTED: contains host binding details]"
			}
		}
	}
}

func redactMapValues(parent map[string]interface{}, key string) {
	if m, ok := parent[key].(map[string]interface{}); ok {
		for k, v := range m {
			s, _ := v.(string)
			if isSecretKey(k, s) {
				m[k] = "••••••••"
			}
		}
	}
}

func isSecretKey(key, value string) bool {
	lower := strings.ToLower(key)
	secretWords := []string{"password", "passwd", "secret", "api_key", "apikey", "api-key", "token", "key", "credential", "auth"}
	for _, w := range secretWords {
		if strings.Contains(lower, w) {
			return true
		}
	}
	if len(value) > 40 && strings.HasPrefix(value, "eyJ") {
		return true
	}
	return false
}
