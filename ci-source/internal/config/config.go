package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"
)

const ConfigFileName = ".ci.conf"

type UserConfig struct {
	Parallelism   int           `json:"parallelism"`
	FuzzDuration  time.Duration `json:"fuzzDuration"`
	FailFast      bool          `json:"failFast"`
	Notifications bool          `json:"notifications"`
	CPUQuota      int64         `json:"cpuQuota"`
	MemoryLimit   int64         `json:"memoryLimit"`
}

func LoadUserConfig() (*UserConfig, error) {
	path, err := findConfigPath()
	if err != nil {
		return nil, err
	}

	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return defaultUserConfig(), nil
		}
		return nil, err
	}

	var cfg UserConfig
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, err
	}

	return &cfg, nil
}

func SaveUserConfig(cfg *UserConfig) error {
	path, err := findConfigPath()
	if err != nil {
		return err
	}

	data, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}

	return os.WriteFile(path, data, 0644)
}

func defaultUserConfig() *UserConfig {
	return &UserConfig{
		Parallelism:   4,
		FuzzDuration:  5 * time.Minute,
		FailFast:      false,
		Notifications: true,
		CPUQuota:      0,
		MemoryLimit:   0,
	}
}

func findConfigPath() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}

	dir := cwd
	for {
		configPath := filepath.Join(dir, ConfigFileName)
		if _, err := os.Stat(configPath); err == nil {
			return configPath, nil
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			return filepath.Join(cwd, ConfigFileName), nil
		}
		dir = parent
	}
}
