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
	Nice          int           `json:"nice"`
	PerfProfile   string        `json:"perfProfile"`
}

// Limits resolves the universal bounds this file sets. They cap every ci run
// on the machine together, not each run alone. The bool is false when the
// profile is "full": no bounds, and runs do not share job slots.
func (c *UserConfig) Limits() (PerfLimits, bool) {
	p := GetPerfProfile(c.PerfProfile)
	if p == nil {
		p = GetPerfProfile(DefaultPerfProfile)
	}
	cur := PerfLimits{Parallelism: c.Parallelism, CPUQuota: c.CPUQuota, MemoryLimit: c.MemoryLimit, Nice: c.Nice}
	if p.ID == PerfFull {
		return PerfLimits{Parallelism: c.Parallelism}, false
	}
	l := p.Resolve(cur)
	l.Parallelism = CapJobs(l.Parallelism, l.CPUQuota)
	return l, true
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

// NewUserConfig returns the settings used when .ci.conf doesn't exist.
func NewUserConfig() *UserConfig { return defaultUserConfig() }

func defaultUserConfig() *UserConfig {
	return &UserConfig{
		Parallelism:   4,
		FuzzDuration:  5 * time.Minute,
		FailFast:      false,
		Notifications: true,
		CPUQuota:      0,
		MemoryLimit:   0,
		PerfProfile:   DefaultPerfProfile,
	}
}

// findConfigPath is the nearest existing .ci.conf above the working directory,
// else a new one at the repository root, so every directory ci runs from reads
// and writes the same file.
func findConfigPath() (string, error) {
	cwd, err := os.Getwd()
	if err != nil {
		return "", err
	}

	root := ""
	dir := cwd
	for {
		configPath := filepath.Join(dir, ConfigFileName)
		if _, err := os.Stat(configPath); err == nil {
			return configPath, nil
		}
		if root == "" {
			if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
				root = dir
			}
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			if root == "" {
				root = cwd
			}
			return filepath.Join(root, ConfigFileName), nil
		}
		dir = parent
	}
}
