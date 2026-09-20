package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
)

// WriteTool returns a Tool that writes file contents.
// Always passes through the review model before execution.
func WriteTool() *Tool {
	return &Tool{
		Name:        "write",
		Description: "Write content to a file on the server, creating it if it doesn't exist. Use for creating or updating configuration files, scripts, and application data. Changing important files will be reviewed for safety before the write happens.",
		ParameterSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"path": {
					"type": "string",
					"description": "Absolute path to the file to write"
				},
				"content": {
					"type": "string",
					"description": "The full content to write to the file"
				}
			},
			"required": ["path", "content"]
		}`),
		AlwaysReview: true,
		PathExtractor: func(args json.RawMessage) string {
			var p struct {
				Path string `json:"path"`
			}
			if err := json.Unmarshal(args, &p); err != nil {
				return ""
			}
			return p.Path
		},
		Execute: executeWrite,
	}
}

func executeWrite(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		Path    string `json:"path"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}
	if params.Path == "" {
		return "", fmt.Errorf("path is required")
	}

	path := filepath.Clean(params.Path)
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("path must be absolute, got: %s", params.Path)
	}

	// Create parent directories if needed
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("cannot create directory %s: %w", dir, err)
	}

	if err := os.WriteFile(path, []byte(params.Content), 0o644); err != nil {
		return "", fmt.Errorf("cannot write %s: %w", path, err)
	}

	return fmt.Sprintf("Wrote %d bytes to %s", len(params.Content), path), nil
}
