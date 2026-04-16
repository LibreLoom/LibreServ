package config

import (
	"errors"
	"path/filepath"
)

func ResolveConfigPath(path string) (string, error) {
	if path == "" {
		return "", errors.New("path not configured")
	}
	if filepath.IsAbs(path) {
		return path, nil
	}

	cfgPath := Path()
	if cfgPath != "" {
		return filepath.Join(filepath.Dir(cfgPath), path), nil
	}

	resolved, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	return resolved, nil
}
