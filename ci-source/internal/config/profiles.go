package config

import (
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/tests"
)

type Profile struct {
	ID          string   `json:"id" yaml:"id"`
	Name        string   `json:"name" yaml:"name"`
	Description string   `json:"description" yaml:"description"`
	TestIDs     []string `json:"testIds" yaml:"testIds"`
}

type Config struct {
	Parallelism   int           `json:"parallelism" yaml:"parallelism"`
	FuzzDuration  time.Duration `json:"fuzzDuration" yaml:"fuzzDuration"`
	FailFast      bool          `json:"failFast" yaml:"failFast"`
	GlobalTimeout time.Duration `json:"globalTimeout" yaml:"globalTimeout"`
	OutputDir     string        `json:"outputDir" yaml:"outputDir"`
	Verbose       bool          `json:"verbose" yaml:"verbose"`
	Notifications bool          `json:"notifications" yaml:"notifications"`
}

var DefaultConfig = Config{
	Parallelism:   4,
	FuzzDuration:  5 * time.Minute,
	FailFast:      false,
	GlobalTimeout: 60 * time.Minute,
	OutputDir:     "./ci-results",
	Verbose:       false,
	Notifications: true,
}

var Profiles = map[string]*Profile{
	"quick": {
		ID:          "quick",
		Name:        "Quick",
		Description: "Fast feedback loop - format, vet, unit tests, lint",
		TestIDs:     []string{"go-fmt", "go-vet", "go-test", "frontend-lint"},
	},
	"backend": {
		ID:          "backend",
		Name:        "Backend",
		Description: "Backend-focused tests - Go tests and coverage",
		TestIDs:     []string{"go-fmt", "go-vet", "go-test", "go-build", "coverage"},
	},
	"frontend": {
		ID:          "frontend",
		Name:        "Frontend",
		Description: "Frontend tests - lint, build, color scan",
		TestIDs:     []string{"frontend-lint", "frontend-build", "frontend-colors"},
	},
	"deep": {
		ID:          "deep",
		Name:        "Deep",
		Description: "Comprehensive testing including race detection, fuzz, and e2e",
		TestIDs: []string{
			"go-fmt", "go-vet", "go-test", "go-race",
			"frontend-lint", "frontend-build",
			"fuzz-docker-unmarshal", "fuzz-apps-definition", "fuzz-network-caddyfile", "fuzz-config-main",
			"e2e",
		},
	},
	"security": {
		ID:          "security",
		Name:        "Security",
		Description: "Security-focused tests - vulnerability scanning, static analysis",
		TestIDs:     []string{"govulncheck", "gosec", "staticcheck"},
	},
	"fuzz": {
		ID:          "fuzz",
		Name:        "Fuzz",
		Description: "Run all fuzz tests",
		TestIDs: []string{
			"fuzz-docker-unmarshal", "fuzz-docker-marshal",
			"fuzz-apps-definition", "fuzz-apps-script",
			"fuzz-network-caddyfile", "fuzz-network-route", "fuzz-network-backend",
			"fuzz-config-main", "fuzz-config-smtp", "fuzz-config-docker", "fuzz-config-caddy", "fuzz-config-acme",
		},
	},
	"full": {
		ID:          "full",
		Name:        "Full",
		Description: "Complete test suite - all tests",
		TestIDs: []string{
			"go-fmt", "go-vet", "go-test", "go-race", "go-build",
			"frontend-lint", "frontend-build", "frontend-colors",
			"fuzz-docker-unmarshal", "fuzz-apps-definition", "fuzz-network-caddyfile", "fuzz-config-main",
			"e2e", "coverage", "docker-build",
			"govulncheck", "gosec", "staticcheck",
			"support-relay", "support-server",
		},
	},
	"e2e": {
		ID:          "e2e",
		Name:        "E2E",
		Description: "End-to-end tests with server",
		TestIDs:     []string{"e2e"},
	},
}

func GetProfile(id string) *Profile {
	return Profiles[id]
}

func ListProfiles() []*Profile {
	result := make([]*Profile, 0, len(Profiles))
	order := []string{"quick", "backend", "frontend", "deep", "security", "fuzz", "e2e", "full"}
	for _, id := range order {
		if p, ok := Profiles[id]; ok {
			result = append(result, p)
		}
	}
	return result
}

func GetTestsForProfile(profileID string) []*tests.Test {
	profile, ok := Profiles[profileID]
	if !ok {
		return nil
	}
	return tests.DefaultRegistry.GetByIDs(profile.TestIDs)
}

func GetAllTests() []*tests.Test {
	return tests.DefaultRegistry.List()
}
