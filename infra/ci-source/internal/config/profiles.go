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

	// Keep the two services separate for cuts; broad profiles compose both.
	solConnectWebTests = []string{
		"connect-web-admin-lint", "connect-web-admin-typecheck", "connect-web-admin-build",
		"connect-web-customer-lint", "connect-web-customer-typecheck", "connect-web-customer-build",
	}
	lunaConnectWebTests = []string{
		"luna-connect-web-lint", "luna-connect-web-test", "luna-connect-web-build",
		"luna-connect-web-colors", "luna-connect-web-typecheck",
		"luna-connect-deploy-test",
	}
	connectWebTests = slices.Concat(solConnectWebTests, lunaConnectWebTests,
		[]string{"connect-deploy-test", "luna-quick-start-check"})

	// fuzzTests is every fuzz test in the Sol backend.
	fuzzTests = []string{
		"fuzz-compose-unmarshal", "fuzz-compose-marshal",
		"fuzz-apps-definition", "fuzz-apps-script",
		"fuzz-network-caddyfile", "fuzz-network-route", "fuzz-network-backend",
		"fuzz-config-main", "fuzz-config-smtp", "fuzz-config-runtime", "fuzz-config-caddy", "fuzz-config-acme",
	}

	lunaWebTests     = []string{"luna-web-recovery-login-test", "luna-shared-ui-recovery-test", "luna-web-colors", "luna-web-lint", "luna-web-typecheck", "luna-web-e2e"}
	lunaOSTests      = slices.Concat(lunaWebTests, []string{"luna-os-ci"})
	lunaDesktopTests = []string{"luna-desktop-ci"}
	lunaAndroidTests = []string{"luna-android-ci"}
	// Broad Luna coverage uses the same lanes as the three cut classes.
	lunaTests = slices.Concat(lunaWebTests, []string{"luna-ci"})

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
	// Cut profiles include cheap tool tests. Packaging validation happens in
	// the actual release build; cache/rebuild stress tests stay in release.
	"cut-sol": {
		ID: "cut-sol", Name: "Cut Sol", Description: "Sol backend, web, security and release tool unit tests",
		TestIDs: cutChecks(solBackendTests, solFrontendTests, solSecurityTests, []string{"release-test"}),
	},
	"cut-sol-connect": {
		ID: "cut-sol-connect", Name: "Cut Sol Connect", Description: "Sol Connect backend, web, security, deployment and release tool unit tests",
		TestIDs: cutChecks(connectGoTests, connectSecurityTests, solConnectWebTests, []string{"connect-deploy-test", "release-test"}),
	},
	"cut-luna-connect": {
		ID: "cut-luna-connect", Name: "Cut Luna Connect", Description: "Luna Connect backend, web, deployment and release tool unit tests",
		TestIDs: cutChecks(lunaConnectGoTests, lunaConnectWebTests, []string{"connect-deploy-test", "release-test"}),
	},
	"cut-luna": {
		ID: "cut-luna", Name: "Cut Luna OS", Description: "Luna daemon, shared crates, web, recovery browser, OS scripts and release tool unit tests",
		TestIDs: slices.Concat(lunaOSTests, []string{"release-test"}),
	},
	"cut-luna-desktop": {
		ID: "cut-luna-desktop", Name: "Cut Luna Desktop", Description: "Luna Desktop, its shared feed library and release tool unit tests",
		TestIDs: slices.Concat(lunaDesktopTests, []string{"release-test"}),
	},
	"cut-luna-android": {
		ID: "cut-luna-android", Name: "Cut Luna Android", Description: "Luna Android and release tool unit tests",
		TestIDs: slices.Concat(lunaAndroidTests, []string{"release-test"}),
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
		TestIDs:     slices.Concat(solBackendTests, solFrontendTests, solSecurityTests, podmanBuildTests),
	},
	"luna": {
		ID:          "luna",
		Name:        "Luna",
		Description: "Luna daemon, web, desktop, and mobile CI (luna/ci.sh), with web unit, browser, and color checks",
		TestIDs:     slices.Concat(lunaTests),
	},
	"luna-fast": {
		ID:          "luna-fast",
		Name:        "Luna Fast",
		Description: "Luna edit/test loop - Rust workspace tests and web unit tests in parallel; no builds, clippy, Android or browser E2E (use luna for the release gate)",
		TestIDs:     []string{"luna-fast"},
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

// Production compilation and packaging are already checked by the real cut
// build. Keep ordinary product tests/static checks, without a second build.
func cutChecks(groups ...[]string) []string {
	return slices.DeleteFunc(slices.Concat(groups...), func(id string) bool {
		switch id {
		case "go-build", "frontend-build", "podman-build", "connect-build", "luna-connect-build",
			"connect-web-admin-build", "connect-web-customer-build", "luna-connect-web-build":
			return true
		}
		return false
	})
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
	"connect", "sol", "luna-fast", "luna",
	"cut-sol", "cut-sol-connect", "cut-luna-connect", "cut-luna", "cut-luna-desktop", "cut-luna-android",
	"release", "nightly", "full",
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
