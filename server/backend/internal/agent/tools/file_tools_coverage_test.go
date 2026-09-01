package tools

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fileToolCoverageArgs(t *testing.T, values map[string]interface{}) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(values)
	if err != nil {
		t.Fatalf("marshal tool arguments: %v", err)
	}
	return data
}

func TestReadToolExecutionCoverage(t *testing.T) {
	tool := ReadTool()
	if tool.Name != "read" || tool.AlwaysReview || tool.Execute == nil {
		t.Fatalf("unexpected read tool: %+v", tool)
	}
	path := filepath.Join(t.TempDir(), "content.txt")
	if err := os.WriteFile(path, []byte("one\ntwo\nthree\nfour"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := tool.PathExtractor(fileToolCoverageArgs(t, map[string]interface{}{"path": path})); got != path {
		t.Fatalf("extracted read path = %q", got)
	}
	if got := tool.PathExtractor(json.RawMessage(`{`)); got != "" {
		t.Fatalf("malformed read path = %q", got)
	}

	result, err := tool.Execute(context.Background(), fileToolCoverageArgs(t, map[string]interface{}{"path": path}))
	if err != nil || result != "one\ntwo\nthree\nfour" {
		t.Fatalf("read result = %q, %v", result, err)
	}
	result, err = tool.Execute(context.Background(), fileToolCoverageArgs(t, map[string]interface{}{
		"path": path, "offset": 2, "limit": 2,
	}))
	if err != nil || !strings.HasPrefix(result, "two\nthree") || !strings.Contains(result, "Showing 2 of 3 lines") {
		t.Fatalf("paginated read = %q, %v", result, err)
	}

	large := filepath.Join(t.TempDir(), "large")
	file, err := os.Create(large)
	if err != nil {
		t.Fatal(err)
	}
	if err := file.Truncate(10*1024*1024 + 1); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name string
		args json.RawMessage
		want string
	}{
		{"invalid JSON", json.RawMessage(`{`), "invalid arguments"},
		{"missing path", json.RawMessage(`{}`), "path is required"},
		{"relative path", json.RawMessage(`{"path":"relative"}`), "path must be absolute"},
		{"missing file", fileToolCoverageArgs(t, map[string]interface{}{"path": filepath.Join(t.TempDir(), "missing")}), "cannot access"},
		{"directory", fileToolCoverageArgs(t, map[string]interface{}{"path": t.TempDir()}), "path is a directory"},
		{"large file", fileToolCoverageArgs(t, map[string]interface{}{"path": large}), "file is too large"},
		{"offset past end", fileToolCoverageArgs(t, map[string]interface{}{"path": path, "offset": 99}), "exceeds file length"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := tool.Execute(context.Background(), tc.args); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestWriteToolExecutionCoverage(t *testing.T) {
	tool := WriteTool()
	if tool.Name != "write" || !tool.AlwaysReview || tool.Execute == nil {
		t.Fatalf("unexpected write tool: %+v", tool)
	}
	path := filepath.Join(t.TempDir(), "nested", "content.txt")
	args := fileToolCoverageArgs(t, map[string]interface{}{"path": path, "content": "written"})
	if got := tool.PathExtractor(args); got != path {
		t.Fatalf("extracted write path = %q", got)
	}
	if got := tool.PathExtractor(json.RawMessage(`{`)); got != "" {
		t.Fatalf("malformed write path = %q", got)
	}
	result, err := tool.Execute(context.Background(), args)
	if err != nil || !strings.Contains(result, "Wrote 7 bytes") {
		t.Fatalf("write result = %q, %v", result, err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "written" {
		t.Fatalf("written data = %q, %v", data, err)
	}

	parentFile := filepath.Join(t.TempDir(), "parent-file")
	if err := os.WriteFile(parentFile, []byte("file"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		args json.RawMessage
		want string
	}{
		{"invalid JSON", json.RawMessage(`{`), "invalid arguments"},
		{"missing path", json.RawMessage(`{}`), "path is required"},
		{"relative path", json.RawMessage(`{"path":"relative","content":"x"}`), "path must be absolute"},
		{"parent is file", fileToolCoverageArgs(t, map[string]interface{}{"path": filepath.Join(parentFile, "child"), "content": "x"}), "cannot create directory"},
		{"target is directory", fileToolCoverageArgs(t, map[string]interface{}{"path": t.TempDir(), "content": "x"}), "cannot write"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := tool.Execute(context.Background(), tc.args); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}

func TestEditToolExecutionCoverage(t *testing.T) {
	tool := EditTool()
	if tool.Name != "edit" || !tool.AlwaysReview || tool.Execute == nil {
		t.Fatalf("unexpected edit tool: %+v", tool)
	}
	path := filepath.Join(t.TempDir(), "content.txt")
	if err := os.WriteFile(path, []byte("before unique after"), 0o640); err != nil {
		t.Fatal(err)
	}
	args := fileToolCoverageArgs(t, map[string]interface{}{"path": path, "old_text": "unique", "new_text": "changed"})
	if got := tool.PathExtractor(args); got != path {
		t.Fatalf("extracted edit path = %q", got)
	}
	if got := tool.PathExtractor(json.RawMessage(`{`)); got != "" {
		t.Fatalf("malformed edit path = %q", got)
	}
	result, err := tool.Execute(context.Background(), args)
	if err != nil || !strings.Contains(result, "Applied edit") {
		t.Fatalf("edit result = %q, %v", result, err)
	}
	if data, err := os.ReadFile(path); err != nil || string(data) != "before changed after" {
		t.Fatalf("edited data = %q, %v", data, err)
	}

	repeated := filepath.Join(t.TempDir(), "repeated")
	if err := os.WriteFile(repeated, []byte("same same"), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		args json.RawMessage
		want string
	}{
		{"invalid JSON", json.RawMessage(`{`), "invalid arguments"},
		{"missing path", json.RawMessage(`{"old_text":"x"}`), "path is required"},
		{"missing old text", fileToolCoverageArgs(t, map[string]interface{}{"path": path}), "old_text is required"},
		{"relative path", json.RawMessage(`{"path":"relative","old_text":"x"}`), "path must be absolute"},
		{"missing file", fileToolCoverageArgs(t, map[string]interface{}{"path": filepath.Join(t.TempDir(), "missing"), "old_text": "x"}), "cannot access"},
		{"directory", fileToolCoverageArgs(t, map[string]interface{}{"path": t.TempDir(), "old_text": "x"}), "path is a directory"},
		{"not found", fileToolCoverageArgs(t, map[string]interface{}{"path": path, "old_text": "absent"}), "was not found"},
		{"multiple matches", fileToolCoverageArgs(t, map[string]interface{}{"path": repeated, "old_text": "same"}), "matches 2 times"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := tool.Execute(context.Background(), tc.args); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("error = %v, want %q", err, tc.want)
			}
		})
	}
}
