package tools

import (
	"context"
	"encoding/json"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/support"
)

type Tool struct {
	Name               string
	Description        string
	ParameterSchema    json.RawMessage
	IsResearch         bool
	RequiresPermission bool
	Execute            func(ctx context.Context, args json.RawMessage) (string, error)
}

type Registry struct {
	tools map[string]*Tool
}

func NewRegistry() *Registry {
	return &Registry{tools: make(map[string]*Tool)}
}

func (r *Registry) Register(t *Tool) {
	r.tools[t.Name] = t
}

func (r *Registry) Get(name string) (*Tool, bool) {
	t, ok := r.tools[name]
	return t, ok
}

func (r *Registry) All() []*Tool {
	var out []*Tool
	for _, t := range r.tools {
		out = append(out, t)
	}
	return out
}

func (r *Registry) ToolDefinitions() []map[string]interface{} {
	if r == nil {
		return nil
	}
	var defs []map[string]interface{}
	for _, t := range r.tools {
		def := map[string]interface{}{
			"type": "function",
			"function": map[string]interface{}{
				"name":        t.Name,
				"description": t.Description,
			},
		}
		if t.ParameterSchema != nil {
			def["function"].(map[string]interface{})["parameters"] = t.ParameterSchema
		}
		defs = append(defs, def)
	}
	return defs
}

type ToolDeps struct {
	RuntimeClient  *docker.Client
	PathPolicy    *support.PathPolicy
	BackupService *storage.BackupService
}

func RegistryFromAgentDef(def config.AgentDefinition, deps ToolDeps) *Registry {
	r := NewRegistry()
	available := map[string][]*Tool{
		"podman":      PodmanTools(deps.RuntimeClient),
		"files":       FileTools(deps.PathPolicy),
		"diagnostics": DiagnosticTools(deps.RuntimeClient),
		"snapshots":   SnapshotTools(deps.BackupService),
	}
	for _, name := range def.ToolNames {
		if group, ok := available[name]; ok {
			for _, t := range group {
				r.Register(t)
			}
		}
	}
	return r
}
