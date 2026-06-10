package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
)

func PodmanTools(client *docker.Client) []*Tool {
	if client == nil {
		return nil
	}

	return []*Tool{
		{
			Name:        "podman_ps",
			Description: "List all running apps and their status.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"all": {"type": "boolean", "description": "Include stopped containers", "default": true}
				}
			}`),
			IsResearch:         true,
			RequiresPermission: false,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				containers, err := client.ListContainersAll(ctx)
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
			Name:        "podman_logs",
			Description: "Get recent logs from an app. Use this to diagnose errors or check output.",
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
				reader, err := client.ContainerLogs(ctx, params.Container, runtime.LogOptions{Follow: false, Tail: params.Tail})
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
			Name:        "podman_inspect",
			Description: "Get detailed information about an app. Environment variables are redacted for security.",
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
				result, err := client.InspectContainer(ctx, params.Container)
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
			Name:        "podman_restart",
			Description: "Restart an app. Use this when an app is stuck or needs a fresh start. Requires user permission.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"container": {"type": "string", "description": "Container name or ID"},
					"timeout": {"type": "integer", "description": "Seconds to wait before killing", "default": 10}
				},
				"required": ["container"]
			}`),
			IsResearch:         false,
			RequiresPermission: true,
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
				if err := client.RestartContainer(ctx, params.Container, timeout); err != nil {
					return "", fmt.Errorf("unable to restart %s: %w", params.Container, err)
				}
				return fmt.Sprintf("Container %s restarted successfully", params.Container), nil
			},
		},
		{
			Name:        "podman_stop",
			Description: "Stop a running app. Requires user permission since it affects service availability.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"container": {"type": "string", "description": "Container name or ID"}
				},
				"required": ["container"]
			}`),
			IsResearch:         false,
			RequiresPermission: true,
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
				if err := client.StopContainer(ctx, params.Container); err != nil {
					return "", fmt.Errorf("unable to stop %s: %w", params.Container, err)
				}
				return fmt.Sprintf("Container %s stopped", params.Container), nil
			},
		},
		{
			Name:        "podman_start",
			Description: "Start a stopped app. Requires user permission since it may have been stopped intentionally.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"container": {"type": "string", "description": "Container name or ID"}
				},
				"required": ["container"]
			}`),
			IsResearch:         false,
			RequiresPermission: true,
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
				if err := client.StartContainer(ctx, params.Container); err != nil {
					return "", fmt.Errorf("unable to start %s: %w", params.Container, err)
				}
				return fmt.Sprintf("Container %s started", params.Container), nil
			},
		},
	}
}

func redactSensitiveFields(parsed map[string]interface{}) {
	if config, ok := parsed["Config"].(map[string]interface{}); ok {
		if env, ok := config["Env"].([]interface{}); ok {
			// Redact individual env vars that contain secrets, but keep non-secret vars visible
			// so the agent can diagnose configuration issues.
			redacted := make([]interface{}, len(env))
			for i, v := range env {
				s, ok := v.(string)
				if !ok {
					redacted[i] = v
					continue
				}
				parts := strings.SplitN(s, "=", 2)
				if len(parts) == 2 && isSecretKey(parts[0], parts[1]) {
					redacted[i] = parts[0] + "=••••••••"
				} else {
					redacted[i] = s
				}
			}
			config["Env"] = redacted
		}
		if _, hasLabels := config["Labels"]; hasLabels {
			redactMapValues(config, "Labels")
		}
	}
	if hostConfig, ok := parsed["HostConfig"].(map[string]interface{}); ok {
		if _, hasLabels := hostConfig["Labels"]; hasLabels {
			redactMapValues(hostConfig, "Labels")
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
