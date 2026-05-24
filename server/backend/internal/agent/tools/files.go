package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/support"
)

func FileTools(policy *support.PathPolicy) []*Tool {
	if policy == nil {
		policy = support.NewDefaultPolicy(nil)
	}

	return []*Tool{
		{
			Name:        "file_read",
			Description: "Read the contents of a file. Secrets are automatically masked. User data requires permission.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"path": {"type": "string", "description": "Absolute path to the file"}
				},
				"required": ["path"]
			}`),
			IsResearch:         true,
			RequiresPermission: true,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				var params struct {
					Path string `json:"path"`
				}
				if err := json.Unmarshal(args, &params); err != nil {
					return "", fmt.Errorf("invalid arguments: %w", err)
				}
				clean := filepath.Clean(params.Path)
				if !filepath.IsAbs(clean) {
					return "", fmt.Errorf("path must be absolute")
				}
				allowed, err := policy.IsAllowed(clean)
				if err != nil || !allowed {
					return "", fmt.Errorf("path not allowed: %s", params.Path)
				}
				data, err := os.ReadFile(clean)
				if err != nil {
					return "", fmt.Errorf("unable to read file: %w", err)
				}
				if len(data) > 2*1024*1024 {
					return "", fmt.Errorf("file too large (over 2MB)")
				}
				content := string(data)
				content = support.MaskSecrets(content)
				return content, nil
			},
		},
		{
			Name:        "file_write",
			Description: "Write content to a file. Creates parent directories if needed. Not allowed for user data without permission.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"path": {"type": "string", "description": "Absolute path to the file"},
					"content": {"type": "string", "description": "Content to write"}
				},
				"required": ["path", "content"]
			}`),
			IsResearch:         false,
			RequiresPermission: true,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				var params struct {
					Path    string `json:"path"`
					Content string `json:"content"`
				}
				if err := json.Unmarshal(args, &params); err != nil {
					return "", fmt.Errorf("invalid arguments: %w", err)
				}
				clean := filepath.Clean(params.Path)
				if !filepath.IsAbs(clean) {
					return "", fmt.Errorf("path must be absolute")
				}
				allowed, err := policy.IsAllowed(clean)
				if err != nil || !allowed {
					return "", fmt.Errorf("path not allowed: %s", params.Path)
				}
				if len(params.Content) > 2*1024*1024 {
					return "", fmt.Errorf("content too large (over 2MB)")
				}
				if err := os.MkdirAll(filepath.Dir(clean), 0o755); err != nil {
					return "", fmt.Errorf("unable to create parent directory: %w", err)
				}
				if err := os.WriteFile(clean, []byte(params.Content), 0o640); err != nil {
					return "", fmt.Errorf("unable to write file: %w", err)
				}
				return fmt.Sprintf("Wrote %d bytes to %s", len(params.Content), clean), nil
			},
		},
		{
			Name:        "config_read",
			Description: "Read a configuration file. Secrets (passwords, API keys, tokens) are masked by default.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"path": {"type": "string", "description": "Absolute path to the config file"}
				},
				"required": ["path"]
			}`),
			IsResearch:         true,
			RequiresPermission: false,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				var params struct {
					Path string `json:"path"`
				}
				if err := json.Unmarshal(args, &params); err != nil {
					return "", fmt.Errorf("invalid arguments: %w", err)
				}
				clean := filepath.Clean(params.Path)
				if !filepath.IsAbs(clean) {
					return "", fmt.Errorf("path must be absolute")
				}
				allowed, err := policy.IsAllowed(clean)
				if err != nil || !allowed {
					return "", fmt.Errorf("path not allowed: %s", params.Path)
				}
				data, err := os.ReadFile(clean)
				if err != nil {
					return "", fmt.Errorf("unable to read config: %w", err)
				}
				content := string(data)
				content = support.MaskSecrets(content)
				return content, nil
			},
		},
		{
			Name:        "file_list",
			Description: "List files and directories at a given path. Returns names, types (file/directory), and sizes. Useful for discovering what is in a directory before reading specific files.",
			ParameterSchema: json.RawMessage(`{
				"type": "object",
				"properties": {
					"path": {"type": "string", "description": "Absolute path to the directory to list"}
				},
				"required": ["path"]
			}`),
			IsResearch:         true,
			RequiresPermission: false,
			Execute: func(ctx context.Context, args json.RawMessage) (string, error) {
				var params struct {
					Path string `json:"path"`
				}
				if err := json.Unmarshal(args, &params); err != nil {
					return "", fmt.Errorf("invalid arguments: %w", err)
				}
				clean := filepath.Clean(params.Path)
				if !filepath.IsAbs(clean) {
					return "", fmt.Errorf("path must be absolute")
				}
				allowed, err := policy.IsAllowed(clean)
				if err != nil || !allowed {
					return "", fmt.Errorf("path not allowed: %s", params.Path)
				}
				entries, err := os.ReadDir(clean)
				if err != nil {
					return "", fmt.Errorf("unable to list directory: %w", err)
				}
				type entry struct {
					Name  string `json:"name"`
					IsDir bool   `json:"is_dir"`
					Size  int64  `json:"size,omitempty"`
				}
				var result []entry
				for _, e := range entries {
					info, infoErr := e.Info()
					size := int64(0)
					if infoErr == nil {
						size = info.Size()
					}
					result = append(result, entry{
						Name:  e.Name(),
						IsDir: e.IsDir(),
						Size:  size,
					})
				}
				if result == nil {
					result = []entry{}
				}
				data, _ := json.MarshalIndent(map[string]interface{}{
					"path":    clean,
					"entries": result,
					"count":   len(result),
				}, "", "  ")
				return string(data), nil
			},
		},
	}
}
