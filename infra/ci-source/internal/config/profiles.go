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
		Description: "Fast feedback - format, vet, unit tests, build, lint, typecheck for backend and connect (12 tests)",
		TestIDs:     []string{"go-fmt", "go-vet", "go-test", "go-build", "go-rollback-test", "frontend-lint", "frontend-test", "frontend-typecheck", "connect-fmt", "connect-vet", "connect-test", "connect-build", "luna-connect-fmt", "luna-connect-vet", "luna-connect-test", "luna-connect-build"},
	},
	"backend": {
		ID:          "backend",
		Name:        "Backend",
		Description: "Backend tests - format, vet, unit tests, race, build, rollback, coverage, connect",
		TestIDs:     []string{"go-fmt", "go-vet", "go-test", "go-race", "go-build", "go-rollback-test", "coverage", "connect-fmt", "connect-vet", "connect-test", "connect-build", "luna-connect-fmt", "luna-connect-vet", "luna-connect-test", "luna-connect-build"},
	},
	"frontend": {
		ID:          "frontend",
		Name:        "Frontend",
		Description: "Frontend tests - lint, test, build, typecheck, color scan (5 tests)",
		TestIDs:     []string{"frontend-lint", "frontend-test", "frontend-build", "frontend-typecheck", "frontend-colors"},
	},
	"deep": {
		ID:          "deep",
		Name:        "Deep",
		Description: "Comprehensive - race detection, rollback, build, all fuzz, connect",
		TestIDs: []string{
			"go-fmt", "go-vet", "go-test", "go-race", "go-build", "go-rollback-test",
			"frontend-lint", "frontend-test", "frontend-build", "frontend-typecheck", "frontend-colors",
			"fuzz-compose-unmarshal", "fuzz-compose-marshal",
			"fuzz-apps-definition", "fuzz-apps-script",
			"fuzz-network-caddyfile", "fuzz-network-route", "fuzz-network-backend",
			"fuzz-config-main", "fuzz-config-smtp", "fuzz-config-runtime", "fuzz-config-caddy", "fuzz-config-acme",
			"connect-fmt", "connect-vet", "connect-test", "connect-build",
			"luna-connect-fmt", "luna-connect-vet", "luna-connect-test", "luna-connect-build",
		},
	},
	"security": {
		ID:          "security",
		Name:        "Security",
		Description: "Security scanning - vulns, gosec, staticcheck for backend and connect",
		TestIDs:     []string{"govulncheck", "gosec", "staticcheck", "connect-gosec", "connect-staticcheck"},
	},
	"fuzz": {
		ID:          "fuzz",
		Name:        "Fuzz",
		Description: "All fuzz tests (12 tests)",
		TestIDs: []string{
			"fuzz-compose-unmarshal", "fuzz-compose-marshal",
			"fuzz-apps-definition", "fuzz-apps-script",
			"fuzz-network-caddyfile", "fuzz-network-route", "fuzz-network-backend",
			"fuzz-config-main", "fuzz-config-smtp", "fuzz-config-runtime", "fuzz-config-caddy", "fuzz-config-acme",
		},
	},
	"full": {
		ID:          "full",
		Name:        "Full",
		Description: "Complete test suite - all tests",
		TestIDs: []string{
			"go-fmt", "go-vet", "go-test", "go-race", "go-build", "go-rollback-test",
			"frontend-lint", "frontend-test", "frontend-build", "frontend-typecheck", "frontend-colors",
			"fuzz-compose-unmarshal", "fuzz-compose-marshal",
			"fuzz-apps-definition", "fuzz-apps-script",
			"fuzz-network-caddyfile", "fuzz-network-route", "fuzz-network-backend",
			"fuzz-config-main", "fuzz-config-smtp", "fuzz-config-runtime", "fuzz-config-caddy", "fuzz-config-acme",
			"govulncheck", "gosec", "staticcheck",
			"connect-gosec", "connect-staticcheck",
			"coverage", "podman-build",
			"connect-fmt", "connect-vet", "connect-test", "connect-build",
			"luna-connect-fmt", "luna-connect-vet", "luna-connect-test", "luna-connect-build",
			"luna-ci",
		},
	},
	"nofuzz": {
		ID:          "nofuzz",
		Name:        "No Fuzz",
		Description: "Everything except fuzz tests - full suite minus fuzzing",
		TestIDs: []string{
			"go-fmt", "go-vet", "go-test", "go-race", "go-build", "go-rollback-test",
			"frontend-lint", "frontend-test", "frontend-build", "frontend-typecheck", "frontend-colors",
			"govulncheck", "gosec", "staticcheck",
			"connect-gosec", "connect-staticcheck",
			"coverage", "podman-build",
			"connect-fmt", "connect-vet", "connect-test", "connect-build",
			"luna-connect-fmt", "luna-connect-vet", "luna-connect-test", "luna-connect-build",
			"luna-ci",
		},
	},
	"connect": {
		ID:          "connect",
		Name:        "Connect",
		Description: "All Connect module tests (6 tests)",
		TestIDs:     []string{"connect-fmt", "connect-vet", "connect-test", "connect-build", "connect-gosec", "connect-staticcheck", "luna-connect-fmt", "luna-connect-vet", "luna-connect-test", "luna-connect-build"},
	},
	"libreserv": {
		ID:          "libreserv",
		Name:        "LibreServ",
		Description: "LibreServ release gate — backend, frontend, security, coverage, podman-build (no Luna, no Connect)",
		TestIDs: []string{
			"go-fmt", "go-vet", "go-test", "go-race", "go-build", "go-rollback-test",
			"frontend-lint", "frontend-test", "frontend-build", "frontend-typecheck", "frontend-colors",
			"govulncheck", "gosec", "staticcheck",
			"coverage", "podman-build",
		},
	},
	"luna": {
		ID:          "luna",
		Name:        "Luna",
		Description: "Luna daemon, web, desktop, and mobile CI (luna/ci.sh)",
		TestIDs:     []string{"luna-ci"},
	},
	"nightly": {
		ID:          "nightly",
		Name:        "Nightly",
		Description: "Gate for the nightly maintenance agent - everything except fuzz",
		TestIDs: []string{
			"go-fmt", "go-vet", "go-test", "go-race", "go-build", "go-rollback-test",
			"frontend-lint", "frontend-test", "frontend-build", "frontend-typecheck", "frontend-colors",
			"govulncheck", "gosec", "staticcheck",
			"connect-gosec", "connect-staticcheck",
			"coverage", "podman-build",
			"connect-fmt", "connect-vet", "connect-test", "connect-build",
			"luna-connect-fmt", "luna-connect-vet", "luna-connect-test", "luna-connect-build",
			"luna-ci",
		},
	},
}

func GetProfile(id string) *Profile {
	return Profiles[id]
}

func ListProfiles() []*Profile {
	result := make([]*Profile, 0, len(Profiles))
	order := []string{"quick", "backend", "frontend", "deep", "security", "fuzz", "nofuzz", "connect", "libreserv", "luna", "nightly", "full"}
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
