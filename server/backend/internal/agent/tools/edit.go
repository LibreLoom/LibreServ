package tools

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// EditTool returns a Tool that performs targeted text replacements in files.
// Always passes through the review model before execution.
func EditTool() *Tool {
	return &Tool{
		Name:        "edit",
		Description: "Make a precise text replacement in a file. Provide the exact text to find and the text to replace it with. The match must be unique in the file. Use this instead of write when you only need to change part of a file.",
		ParameterSchema: json.RawMessage(`{
			"type": "object",
			"properties": {
				"path": {
					"type": "string",
					"description": "Absolute path to the file to edit"
				},
				"old_text": {
					"type": "string",
					"description": "The exact text to find and replace. Must match exactly once in the file."
				},
				"new_text": {
					"type": "string",
					"description": "The replacement text"
				}
			},
			"required": ["path", "old_text", "new_text"]
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
		Execute: executeEdit,
	}
}

func executeEdit(ctx context.Context, args json.RawMessage) (string, error) {
	var params struct {
		Path    string `json:"path"`
		OldText string `json:"old_text"`
		NewText string `json:"new_text"`
	}
	if err := json.Unmarshal(args, &params); err != nil {
		return "", fmt.Errorf("invalid arguments: %w", err)
	}
	if params.Path == "" {
		return "", fmt.Errorf("path is required")
	}
	if params.OldText == "" {
		return "", fmt.Errorf("old_text is required")
	}

	path := filepath.Clean(params.Path)
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("path must be absolute, got: %s", params.Path)
	}

	info, err := os.Stat(path)
	if err != nil {
		return "", fmt.Errorf("cannot access %s: %w", path, err)
	}
	if info.IsDir() {
		return "", fmt.Errorf("path is a directory, not a file: %s", path)
	}

	data, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("cannot read %s: %w", path, err)
	}
	content := string(data)

	count := strings.Count(content, params.OldText)
	if count == 0 {
		return "", fmt.Errorf("old_text was not found in %s", path)
	}
	if count > 1 {
		return "", fmt.Errorf("old_text matches %d times in %s — it must be unique. Provide more surrounding context to make it specific.", count, path)
	}

	newContent := strings.Replace(content, params.OldText, params.NewText, 1)

	if err := os.WriteFile(path, []byte(newContent), info.Mode()); err != nil {
		return "", fmt.Errorf("cannot write %s: %w", path, err)
	}

	return fmt.Sprintf("Applied edit to %s (%d bytes → %d bytes)", path, len(content), len(newContent)), nil
}
