package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
)

func DiagnosticTools(dockerClient *docker.Client) []*Tool {
	tools := []*Tool{
		{
			Name:        "system_health",
			Description: "Get system health information including Docker daemon status.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {}
			}`),
			IsResearch:         true,
			RequiresPermission: false,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				result := make(map[string]interface{})
				if dockerClient != nil {
					if err := dockerClient.HealthCheck(); err != nil {
						result["docker"] = map[string]interface{}{"status": "unhealthy", "error": err.Error()}
					} else {
						result["docker"] = map[string]interface{}{"status": "healthy"}
					}
				}
				data, _ := json.MarshalIndent(result, "", "  ")
				return string(data), nil
			},
		},
	}

	if dockerClient != nil {
		tools = append(tools, &Tool{
			Name:        "docker_health",
			Description: "Check the health status of a specific Docker container.",
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
					return "", fmt.Errorf("unable to check health for %s: %w", params.Container, err)
				}
				var parsed map[string]interface{}
				if err := json.Unmarshal(result.Raw, &parsed); err != nil {
					return string(result.Raw), nil
				}
				state, _ := parsed["State"].(map[string]interface{})
				out := map[string]interface{}{
					"container": params.Container,
					"status":    "unknown",
				}
				if state != nil {
					if s, ok := state["Status"].(string); ok {
						out["status"] = s
					}
					if h, ok := state["Health"].(map[string]interface{}); ok {
						out["health"] = h
					}
				}
				data, _ := json.MarshalIndent(out, "", "  ")
				return string(data), nil
			},
		})
	}

	return tools
}
