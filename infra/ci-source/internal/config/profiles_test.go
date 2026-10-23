package config

import "testing"

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
			for _, testID := range []string{"luna-web-colors", "luna-web-e2e"} {
				if counts[testID] != 1 {
					t.Errorf("profile %q has %d entries for %q; want exactly one", profileID, counts[testID], testID)
				}
			}
			if counts["luna-web-test"] != 0 {
				t.Errorf("profile %q duplicates the focused web unit test alongside luna-ci", profileID)
			}
		})
	}
}
