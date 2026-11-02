package config

import "testing"

func TestTailscalePackagingRunsInReleaseProfiles(t *testing.T) {
	for _, name := range []string{"sol", "luna", "full", "nofuzz", "nightly"} {
		found := false
		for _, id := range Profiles[name].TestIDs {
			if id == "tailscale-packaging" {
				found = true
			}
		}
		if !found {
			t.Errorf("%s does not guard pinned remote-access packages", name)
		}
	}
}

func TestTailscaleProfileIncludesStandaloneChecks(t *testing.T) {
	wanted := map[string]bool{"tailscale-packaging": false, "luna-daemon-check": false, "luna-web-check": false}
	for _, id := range Profiles["tailscale"].TestIDs {
		if _, ok := wanted[id]; ok {
			wanted[id] = true
		}
	}
	for id, found := range wanted {
		if !found {
			t.Errorf("Tailscale profile omits %s", id)
		}
	}
}

func TestBroadProfilesRunLunaRecoveryBrowserAndColorChecks(t *testing.T) {
	for _, profileID := range []string{"full", "nofuzz", "nightly"} {
		t.Run(profileID, func(t *testing.T) {
			profile := GetProfile(profileID)
			if profile == nil {
				t.Fatalf("profile %q is missing", profileID)
			}

			counts := make(map[string]int)
			for _, testID := range profile.TestIDs {
				counts[testID]++
			}
			for _, testID := range []string{"luna-shared-ui-recovery-test", "luna-web-colors", "luna-web-e2e"} {
				if counts[testID] != 1 {
					t.Errorf("profile %q has %d entries for %q; want exactly one", profileID, counts[testID], testID)
				}
			}
			if counts["luna-web-recovery-login-test"] != 1 {
				t.Errorf("profile %q has %d entries for %q; want exactly one", profileID, counts["luna-web-recovery-login-test"], "luna-web-recovery-login-test")
			}
		})
	}
}
