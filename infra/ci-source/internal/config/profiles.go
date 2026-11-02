package config

import (
	"slices"
	"sort"
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

// Test-ID groups. The profiles are built by concatenating these, so a test that
// belongs to an area is added in one place instead of in every profile that
// runs it. A group's order is the order ./ci lists and runs its tests in.
var (
	// solBackend is the Sol Go backend: format, vet, unit tests (which write
	// the coverage report), race, build, and the platform rollback tests.
	solBackendTests = []string{"go-fmt", "go-vet", "go-test", "go-race", "go-build", "go-rollback-test"}

	// solFrontend is the Sol web frontend.
	solFrontendTests = []string{"frontend-lint", "frontend-test", "frontend-build", "frontend-typecheck", "frontend-colors"}

	// solSecurity is the Sol backend security scan.
	solSecurityTests = []string{"govulncheck", "gosec", "staticcheck"}

	// connectGoTests and lunaConnectGoTests are the two Connect Go modules.
	connectGoTests     = []string{"connect-fmt", "connect-vet", "connect-test", "connect-build"}
	lunaConnectGoTests = []string{"luna-connect-fmt", "luna-connect-vet", "luna-connect-test", "luna-connect-build"}

	// connectSecurityTests is the Sol Connect security scan.
	connectSecurityTests = []string{"connect-gosec", "connect-staticcheck"}

	// connectWebTests is every Connect web frontend (admin, customer, Luna
	// Connect), plus the Luna quick-start page and the Luna Connect deploy
	// script tests.
	connectWebTests = []string{
		"connect-web-admin-lint", "connect-web-admin-typecheck", "connect-web-admin-build",
		"connect-web-customer-lint", "connect-web-customer-typecheck", "connect-web-customer-build",
		"luna-connect-web-lint", "luna-connect-web-test", "luna-connect-web-build",
		"luna-connect-web-colors", "luna-connect-web-typecheck",
		"luna-quick-start-check", "luna-connect-deploy-test",
	}

	// fuzzTests is every fuzz test in the Sol backend.
	fuzzTests = []string{
		"fuzz-compose-unmarshal", "fuzz-compose-marshal",
		"fuzz-apps-definition", "fuzz-apps-script",
		"fuzz-network-caddyfile", "fuzz-network-route", "fuzz-network-backend",
		"fuzz-config-main", "fuzz-config-smtp", "fuzz-config-runtime", "fuzz-config-caddy", "fuzz-config-acme",
	}

	// lunaTests is the Luna gate: luna/ci.sh plus the web unit, browser and
	// color checks.
	lunaTests = []string{"luna-web-recovery-login-test", "luna-shared-ui-recovery-test", "luna-web-colors", "luna-web-lint", "luna-web-typecheck", "luna-web-e2e", "luna-ci", "tailscale-packaging"}

	// releaseTests is the release and ci tools' own tests that need no long
	// builds; releaseSlowTests is the multi-minute builds only the release
	// profile runs.
	releaseTests     = []string{"release-test", "release-integration"}
	releaseSlowTests = []string{"release-slow"}

	// podmanBuildTests builds the Sol container image on the host.
	podmanBuildTests = []string{"podman-build"}

	// quickBackendTests and quickFrontendTests are the fast subset the quick
	// profile runs: no race run (it needs cgo) and no frontend build or color
	// scan.
	quickBackendTests  = []string{"go-fmt", "go-vet", "go-test", "go-build", "go-rollback-test"}
	quickFrontendTests = []string{"frontend-lint", "frontend-test", "frontend-typecheck"}
)

var Profiles = map[string]*Profile{
	"quick": {
		ID:          "quick",
		Name:        "Quick",
		Description: "Fast feedback - format, vet, unit tests, build, lint and typecheck for Sol and both Connect modules",
		TestIDs:     slices.Concat(quickBackendTests, quickFrontendTests, connectGoTests, lunaConnectGoTests),
	},
	"backend": {
		ID:          "backend",
		Name:        "Backend",
		Description: "Backend tests - format, vet, unit tests (with coverage), race, build, rollback, and the Connect Go and web tests",
		TestIDs:     slices.Concat(solBackendTests, connectGoTests, lunaConnectGoTests, connectWebTests),
	},
	"frontend": {
		ID:          "frontend",
		Name:        "Frontend",
		Description: "Frontend tests - lint, test, build, typecheck, color scan",
		TestIDs:     slices.Concat(solFrontendTests),
	},
	"deep": {
		ID:          "deep",
		Name:        "Deep",
		Description: "Sol backend and frontend, all fuzz, and the Connect tests - no security, podman-build, Luna gate or release tests",
		TestIDs:     slices.Concat(solBackendTests, solFrontendTests, fuzzTests, connectGoTests, lunaConnectGoTests, connectWebTests),
	},
	"security": {
		ID:          "security",
		Name:        "Security",
		Description: "Security scanning - vulns, gosec, staticcheck for backend and connect",
		TestIDs:     slices.Concat(solSecurityTests, connectSecurityTests),
	},
	"fuzz": {
		ID:          "fuzz",
		Name:        "Fuzz",
		Description: "All fuzz tests",
		TestIDs:     slices.Concat(fuzzTests),
	},
	"full": {
		ID:          "full",
		Name:        "Full",
		Description: "Complete test suite - every test except the release tool's slow builds",
		TestIDs: slices.Concat(
			solBackendTests, solFrontendTests, fuzzTests,
			solSecurityTests, connectSecurityTests, podmanBuildTests,
			connectGoTests, lunaConnectGoTests, connectWebTests,
			lunaTests, releaseTests,
		),
	},
	// nofuzz and nightly resolve to the same 45 test IDs in the same order.
	// One of the two is dead weight, but which (if either) to drop is a product
	// decision, so both stay for now - keep them in step until that is settled.
	"nofuzz": {
		ID:          "nofuzz",
		Name:        "No Fuzz",
		Description: "Everything except fuzz tests - full suite minus fuzzing",
		TestIDs: slices.Concat(
			solBackendTests, solFrontendTests,
			solSecurityTests, connectSecurityTests, podmanBuildTests,
			connectGoTests, lunaConnectGoTests, connectWebTests,
			lunaTests, releaseTests,
		),
	},
	"release": {
		ID:          "release",
		Name:        "Release tool",
		Description: "The release and ci tools' own tests, including the podman integration tests and the slow builds",
		TestIDs:     slices.Concat(releaseTests, releaseSlowTests),
	},
	"connect": {
		ID:          "connect",
		Name:        "Connect",
		Description: "All Connect module tests - Go, security and web for Sol Connect and Luna Connect",
		TestIDs:     slices.Concat(connectGoTests, connectSecurityTests, lunaConnectGoTests, connectWebTests),
	},
	"sol": {
		ID:          "sol",
		Name:        "LibreServ",
		Description: "LibreServ release gate — backend, frontend, security, podman-build (unit tests carry the coverage report; no Luna, no Connect)",
		TestIDs:     slices.Concat(solBackendTests, solFrontendTests, solSecurityTests, podmanBuildTests, []string{"tailscale-packaging"}),
	},
	"luna": {
		ID:          "luna",
		Name:        "Luna",
		Description: "Luna daemon, web, desktop, and mobile CI (luna/ci.sh), with web unit, browser, and color checks",
		TestIDs:     slices.Concat(lunaTests),
	},
	"tailscale": {
		ID: "tailscale", Name: "Tailscale",
		Description: "Remote access packaging, daemon and web checks without OS toolchains",
		TestIDs:     []string{"tailscale-packaging", "luna-daemon-check", "luna-web-check", "go-test", "go-vet", "staticcheck", "frontend-test", "frontend-typecheck", "frontend-colors", "release-test"},
	},
	// nightly is identical to nofuzz (see above): same 45 test IDs in the same
	// order. One of the two is dead weight; both stay until that is decided.
	"nightly": {
		ID:          "nightly",
		Name:        "Nightly",
		Description: "Everything except fuzz - the full suite minus fuzzing",
		TestIDs: slices.Concat(
			solBackendTests, solFrontendTests,
			solSecurityTests, connectSecurityTests, podmanBuildTests,
			connectGoTests, lunaConnectGoTests, connectWebTests,
			lunaTests, releaseTests,
		),
	},
}

func GetProfile(id string) *Profile {
	return Profiles[id]
}

// profileOrder is the order ./ci profiles and the TUI list profiles in: the
// fast, narrow ones first, the broad ones last. "quick" must stay first - the
// TUI starts on profiles[0].
//
// A profile missing from this list is still listed by ListProfiles (sorted
// after the ones named here) and TestProfileOrderListsEveryProfileOnce fails,
// so a profile cannot go missing the way "release" did.
var profileOrder = []string{
	"quick", "backend", "frontend", "deep", "security", "fuzz", "nofuzz",
	"connect", "sol", "luna", "tailscale", "release", "nightly", "full",
}

// ListProfiles returns every profile exactly once: those named in profileOrder
// in that order, then any it does not name, sorted, so none can be silently
// absent.
func ListProfiles() []*Profile {
	result := make([]*Profile, 0, len(Profiles))
	listed := make(map[string]bool, len(Profiles))
	for _, id := range profileOrder {
		if p, ok := Profiles[id]; ok {
			result = append(result, p)
			listed[id] = true
		}
	}

	rest := make([]string, 0, len(Profiles)-len(result))
	for id := range Profiles {
		if !listed[id] {
			rest = append(rest, id)
		}
	}
	sort.Strings(rest)
	for _, id := range rest {
		result = append(result, Profiles[id])
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
