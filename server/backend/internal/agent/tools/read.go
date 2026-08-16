package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ReadTool returns a Tool that reads file contents.
// Paths touching configured data directories trigger user permission;
// all other paths auto-execute. The review model is NOT consulted for reads.
func ReadTool() *Tool {
	return &Tool{
		Name:        "read",
		Description: "Read the contents of a file on the server. Use for inspecting configuration files, logs, application data, and system information. Access to sensitive data directories will require your approval before the file is read.",
		ParameterSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"path": {
					"type": "string",
					"description": "Absolute path to the file to read"
				},
				"offset": {
					"type": "integer",
					"description": "Line number to start reading from (1-based, optional)"
				},
				"limit": {
					"type": "integer",
					"description": "Maximum number of lines to read (optional)",
					"default": 200
				}
			},
			"required": ["path"]
		}`),
		AlwaysReview: false,
		PathExtractor: func(args json.RawMessage) string {
			var params struct {
				Path string `json:"path"`
			}
			if err := json.Unmarshal(args, &params); err != nil {
				return ""
			}
			return params.Path
		},
		Execute: executeRead,
	}
}

func executeRead(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		Path   string `json:"path"`
		Offset int    `json:"offset"`
		Limit  int    `json:"limit"`
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

	// Prevent directory traversal outside the filesystem root
	if !strings.HasPrefix(path, "/") {
		return "", fmt.Errorf("invalid path")
	}

	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("cannot access %s: %w", path, err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("path is a directory, not a file: %s", path)
	}

	// Limit file size: max 10MB
	if info.Size() > 10*1024*1024 {
		return "", fmt.Errorf("file is too large (%d bytes). Ask the user what specific section they need", info.Size())
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("cannot read %s: %w", path, err)
	}

	content := string(data)

	// Apply offset/limit line-based pagination
	if params.Limit <= 0 {
		params.Limit = 200
	}
	lines := strings.Split(content, "\n")
	if params.Offset > 0 {
		if params.Offset > len(lines) {
			return "", fmt.Errorf("offset %d exceeds file length (%d lines)", params.Offset, len(lines))
		}
		lines = lines[params.Offset-1:]
	}
	if len(lines) > params.Limit {
		totalLines := len(lines)
		lines = lines[:params.Limit]
		result := strings.Join(lines, "\n")
		result += fmt.Sprintf("\n\n[Showing %d of %d lines. Use offset to see more.]", params.Limit, totalLines)
		return result, nil
	}

	return strings.Join(lines, "\n"), nil
}
