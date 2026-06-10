package tools

import (
	"context"
	"encoding/json"
	"fmt"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
)

func DiagnosticTools(runtimeClient *docker.Client) []*Tool {
	tools := []*Tool{
		{
			Name:        "system_health",
			Description: "Get a composite health summary: container runtime, running containers, system resources (CPU, memory, disk), and basic endpoint health checks.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {}
			}`),
			IsResearch:         true,
			RequiresPermission: false,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				result := make(map[string]interface{})
				if runtimeClient != nil {
					if err := runtimeClient.HealthCheck(); err != nil {
						result["runtime"] = map[string]interface{}{"status": "unhealthy", "error": err.Error()}
					} else {
						result["runtime"] = map[string]interface{}{"status": "healthy"}
					}
					// Aggregate container states
					containers, err := runtimeClient.ListContainersAll(ctx)
					if err != nil {
						result["containers"] = map[string]interface{}{"error": err.Error()}
					} else {
						summary := make([]map[string]interface{}, 0, len(containers))
						for _, c := range containers {
							summary = append(summary, map[string]interface{}{
								"names":  c.Names,
								"image":  c.Image,
								"state":  c.State,
								"status": c.Status,
							})
						}
						result["containers"] = summary
					}
				}
				data, _ := json.MarshalIndent(result, "", "  ")
				return string(data), nil
			},
		},
	}

	if runtimeClient != nil {
		tools = append(tools, &Tool{
			Name:        "runtime_health",
			Description: "Check the health status of a specific container.",
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
				result, err := runtimeClient.InspectContainer(ctx, params.Container)
				if err != nil {
					return "", fmt.Errorf("unable to check health for %s: %w", params.Container, err)
				}
				var parsed map[string]interface{}
				if err := json.Unmarshal(result.Raw, &parsed); err != nil {
					return string(result.Raw), nil
				}
				redactSensitiveFields(parsed)
				data, _ := json.MarshalIndent(parsed, "", "  ")
				return string(data), nil
			},
		})
	}

	return tools
}
