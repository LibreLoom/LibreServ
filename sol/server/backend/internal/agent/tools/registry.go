package tools

import (
	"context"
	"encoding/json"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/agent/sandbox"
)

// Tool is a callable function exposed to the agent.
type Tool struct {
	Name        string
	Description string
	// ParameterSchema is the JSON Schema for the tool's arguments (OpenAI format).
	ParameterSchema json.RawMessage
	// AlwaysReview means every invocation passes through the review model.
	AlwaysReview bool
	// AlwaysRequirePermission means every invocation requires user permission,
	// bypassing the review model entirely.
	AlwaysRequirePermission bool
	// PathExtractor extracts a filesystem path from the tool arguments, if applicable.
	// Used by the read tool to check against data-directory boundaries.
	PathExtractor func(args json.RawMessage) string
	// Execute runs the tool and returns the result.
	Execute func(ctx context.Context, args json.RawMessage) (string, error)
}

// Registry holds all available tools.
type Registry struct {
	tools map[string]*Tool
}

// newRegistry creates an empty Registry.
func newRegistry() *Registry {
	return &Registry{tools: make(map[string]*Tool)}
}

// Register adds a tool.
func (r *Registry) Register(t *Tool) {
	r.tools[t.Name] = t
}

// Get returns a tool by name.
func (r *Registry) Get(name string) (*Tool, bool) {
	t, ok := r.tools[name]
	return t, ok
}

// ToolDefinitions returns OpenAI-format tool definitions for the provider.
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

// StandardRegistry returns a Registry with the four pi-style tools. The bash
// tool runs commands through the provided sandbox, which supplies the OS-level
// execution boundary; pass sandbox.New(cfg) (or a backend of your choice).
func StandardRegistry(sb sandbox.Sandbox) *Registry {
	r := newRegistry()
	r.Register(BashTool(sb))
	r.Register(ReadTool())
	r.Register(WriteTool())
	r.Register(EditTool())
	return r
}
