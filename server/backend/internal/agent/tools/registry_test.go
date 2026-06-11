package tools

import (
	"testing"
)

func TestStandardRegistry(t *testing.T) {
	r := StandardRegistry()
	if r == nil {
		t.Fatal("StandardRegistry returned nil")
	}

	// All four pi-style tools should be registered.
	expected := []string{"bash", "read", "write", "edit"}
	for _, name := range expected {
		tool, ok := r.Get(name)
		if !ok {
			t.Errorf("tool %q not found in registry", name)
			continue
		}
		if tool.Name != name {
			t.Errorf("tool.Name = %q, want %q", tool.Name, name)
		}
	}

	all := r.All()
	if len(all) != 4 {
		t.Errorf("All() = %d tools, want 4", len(all))
	}
}

func TestToolDefinitions(t *testing.T) {
	r := StandardRegistry()
	defs := r.ToolDefinitions()
	if len(defs) != 4 {
		t.Fatalf("ToolDefinitions() = %d, want 4", len(defs))
	}

	names := map[string]bool{}
	for _, def := range defs {
		fn, ok := def["function"].(map[string]interface{})
		if !ok {
			t.Fatal("tool definition missing 'function' key")
		}
		name, ok := fn["name"].(string)
		if !ok {
			t.Fatal("tool definition missing function.name")
		}
		names[name] = true
	}

	for _, expected := range []string{"bash", "read", "write", "edit"} {
		if !names[expected] {
			t.Errorf("tool definition missing for %q", expected)
		}
	}
}

func TestToolClassification(t *testing.T) {
	r := StandardRegistry()

	// bash, write, edit should always be reviewed.
	for _, name := range []string{"bash", "write", "edit"} {
		tool, ok := r.Get(name)
		if !ok {
			t.Fatal("tool not found:", name)
		}
		if !tool.AlwaysReview {
			t.Errorf("%s.AlwaysReview = false, want true", name)
		}
		if tool.AlwaysRequirePermission {
			t.Errorf("%s.AlwaysRequirePermission = true, want false", name)
		}
	}

	// read should not always be reviewed (has special path checking).
	readTool, ok := r.Get("read")
	if !ok {
		t.Fatal("read tool not found")
	}
	if readTool.AlwaysReview {
		t.Error("read.AlwaysReview = true, want false")
	}
	if readTool.PathExtractor == nil {
		t.Error("read.PathExtractor should be set for data-dir checking")
	}
}

func TestReadToolPathExtractor(t *testing.T) {
	r := StandardRegistry()
	readTool, ok := r.Get("read")
	if !ok {
		t.Fatal("read tool not found")
	}

	path := readTool.PathExtractor([]byte(`{"path": "/var/lib/libreserv/test.txt"}`))
	if path != "/var/lib/libreserv/test.txt" {
		t.Errorf("PathExtractor = %q, want %q", path, "/var/lib/libreserv/test.txt")
	}

	empty := readTool.PathExtractor([]byte(`{}`))
	if empty != "" {
		t.Errorf("PathExtractor({}) = %q, want empty", empty)
	}
}
