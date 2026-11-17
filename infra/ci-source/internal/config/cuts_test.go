package config

import (
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/tests"
)

func TestCutProfilesStayWithinTheirReleaseUnit(t *testing.T) {
	for _, tc := range []struct {
		unit, root string
		required   []string
	}{
		{"sol", "/repo/sol/server", []string{"go-test", "go-race", "frontend-test", "govulncheck", "gosec", "staticcheck"}},
		{"sol-connect", "/repo/sol/connect", []string{"connect-test", "connect-gosec", "connect-staticcheck", "connect-web-admin-lint", "connect-web-customer-typecheck", "connect-deploy-test"}},
		{"luna-connect", "/repo/luna/connect", []string{"luna-connect-test", "luna-connect-web-test", "luna-connect-deploy-test", "connect-deploy-test"}},
		{"luna", "/repo/luna/web", []string{"luna-os-ci", "luna-web-recovery-login-test", "luna-shared-ui-recovery-test", "luna-web-e2e", "luna-web-colors", "luna-web-lint", "luna-web-typecheck"}},
		{"luna-desktop", "", []string{"luna-desktop-ci"}},
		{"luna-android", "", []string{"luna-android-ci"}},
	} {
		t.Run(tc.unit, func(t *testing.T) {
			p := GetProfile("cut-" + tc.unit)
			if p == nil {
				t.Fatal("missing cut profile")
			}
			for _, id := range append(tc.required, "release-test") {
				if !slices.Contains(p.TestIDs, id) {
					t.Errorf("missing %s", id)
				}
			}
			seen := map[string]bool{}
			for _, test := range GetTestsForProfile(p.ID) {
				if seen[test.ID] {
					t.Errorf("duplicate %s", test.ID)
				}
				seen[test.ID] = true
				if test.ID == "release-test" {
					if !strings.Contains(test.Command, "go test -short") || !slices.Contains(test.Env, "LIBRESERV_RELEASE_NO_PODMAN_TESTS=1") {
						t.Error("common tool checks must not build real artifacts")
					}
					continue
				}
				if test.Type == tests.TestTypeIntegration || strings.HasSuffix(test.ID, "-build") || test.ID == "go-build" {
					t.Errorf("%s repeats packaging before the real release build", test.ID)
				}
				if slices.Contains(tc.required, test.ID) {
					continue
				}
				if tc.root != "" && strings.HasPrefix(test.WorkDir, tc.root+"/") {
					continue
				}
				if test.WorkDir == tc.root && tc.root != "" {
					continue
				}
				t.Errorf("unrelated job %s (%s) in %s", test.ID, test.WorkDir, p.ID)
			}
		})
	}
}

func TestLunaCutLanesExcludeOtherCompanions(t *testing.T) {
	script, err := filepath.Abs("../../../../luna/ci.sh")
	if err != nil {
		t.Fatal(err)
	}
	// Inspect the exact lists consumed by the scheduler, before any SDK or
	// cache setup. No product tests or builds are launched by this query.
	for _, tc := range []struct{ scope, lanes string }{
		{"os", "lane_check lane_clippy lane_os lane_web lane_web_unit"},
		{"desktop", "lane_rust lane_feed"},
		{"android", "lane_mobile"},
		{"all", "lane_check lane_clippy lane_rust lane_mobile lane_os lane_web lane_web_unit"},
	} {
		t.Run(tc.scope, func(t *testing.T) {
			if tc.scope != "all" {
				id := "luna-" + tc.scope + "-ci"
				registered := tests.DefaultRegistry.GetByIDs([]string{id})
				if len(registered) != 1 || registered[0].Command != "./luna/ci.sh "+tc.scope {
					t.Fatalf("incorrect registered scope %s", id)
				}
			}
			cmd := exec.Command("sh", script, "--list-lanes", tc.scope)
			cmd.Dir = t.TempDir()
			cmd.Env = append(os.Environ(), "CARGO_HOME=/unwritable-cargo", "ANDROID_HOME=/unwritable-sdk")
			out, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatalf("scope query: %v %s", err, out)
			}
			if got := strings.Join(strings.Fields(string(out)), " "); got != tc.lanes {
				t.Fatalf("got %s, want %s", got, tc.lanes)
			}
		})
	}
	if err := exec.Command("sh", script, "--list-lanes", "unknown").Run(); err == nil {
		t.Fatal("unknown scope must fail")
	}
}
