package tools

import (
	"context"
	"encoding/json"
	"testing"
)

func TestRegistryRegisterAndGet(t *testing.T) {
	r := NewRegistry()

	tool := &Tool{
		Name:        "test_tool",
		Description: "A test tool",
		IsResearch:  true,
		Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
			return "ok", nil
		},
	}
	r.Register(tool)

	got, ok := r.Get("test_tool")
	if !ok {
		t.Fatal("expected to find registered tool")
	}
	if got.Name != "test_tool" {
		t.Errorf("got.Name = %q, want %q", got.Name, "test_tool")
	}
}

func TestRegistryGetNonexistent(t *testing.T) {
	r := NewRegistry()
	_, ok := r.Get("nonexistent")
	if ok {
		t.Error("expected tool not to be found")
	}
}

func TestRegistryToolDefinitions(t *testing.T) {
	r := NewRegistry()
	r.Register(&Tool{
		Name:            "tool_a",
		Description:     "Tool A",
		ParameterSchema: json.RawMessage(`{"type": "object"}`),
		IsResearch:      true,
	})
	r.Register(&Tool{
		Name:               "tool_b",
		Description:        "Tool B",
		ParameterSchema:    json.RawMessage(`{"type": "object"}`),
		IsResearch:         false,
		RequiresPermission: true,
	})

	defs := r.ToolDefinitions()
	if len(defs) != 2 {
		t.Fatalf("ToolDefinitions() returned %d definitions, want 2", len(defs))
	}

	names := map[string]bool{}
	for _, d := range defs {
		if fn, ok := d["function"].(map[string]interface{}); ok {
			if name, ok := fn["name"].(string); ok {
				names[name] = true
			}
		}
	}
	if !names["tool_a"] || !names["tool_b"] {
		t.Error("missing expected tool definitions")
	}
}

func TestToolExecution(t *testing.T) {
	tool := &Tool{
		Name:        "echo",
		Description: "Echo tool",
		IsResearch:  true,
		Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
			var params struct {
				Message string `json:"message"`
			}
			json.Unmarshal(args, &params)
			return params.Message, nil
		},
	}

	result, err := tool.Execute(context.Background(), json.RawMessage(`{"message": "hello"}`))
	if err != nil {
		t.Fatalf("Execute() error: %v", err)
	}
	if result != "hello" {
		t.Errorf("Execute() = %q, want %q", result, "hello")
	}
}
