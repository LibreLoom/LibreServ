package config

import (
	"regexp"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/ci/internal/tests"
)

// TestProfileOrderListsEveryProfileOnce keeps ListProfiles honest: a profile
// that is in Profiles but not in profileOrder used to be silently left out of
// ./ci profiles and the TUI (that is how "release" went missing), and an entry
// in profileOrder with no profile behind it is a typo waiting to happen.
func TestProfileOrderListsEveryProfileOnce(t *testing.T) {
	inOrder := make(map[string]int, len(profileOrder))
	for _, id := range profileOrder {
		inOrder[id]++
	}

	for id := range Profiles {
		switch n := inOrder[id]; {
		case n == 0:
			t.Errorf("profile %q is in Profiles but missing from profileOrder; it would not be listed", id)
		case n > 1:
			t.Errorf("profile %q appears %d times in profileOrder; want exactly one", id, n)
		}
	}
	for id := range inOrder {
		if _, ok := Profiles[id]; !ok {
			t.Errorf("profileOrder names %q, which is not a profile", id)
		}
	}

	listed := make(map[string]int, len(Profiles))
	for _, p := range ListProfiles() {
		listed[p.ID]++
	}
	for id := range Profiles {
		if listed[id] != 1 {
			t.Errorf("ListProfiles returned %q %d times; want exactly one", id, listed[id])
		}
	}
	if len(listed) != len(Profiles) {
		t.Errorf("ListProfiles returned %d profiles; want %d", len(listed), len(Profiles))
	}
}

// TestQuickProfileIsListedFirst guards the TUI, which starts on profiles[0].
func TestQuickProfileIsListedFirst(t *testing.T) {
	profiles := ListProfiles()
	if len(profiles) == 0 {
		t.Fatal("ListProfiles returned nothing")
	}
	if profiles[0].ID != "quick" {
		t.Errorf("first listed profile is %q; want %q", profiles[0].ID, "quick")
	}
}

// TestProfileTestIDsExist keeps a profile from naming a test the registry does
// not have: GetTestsForProfile drops unknown IDs silently, so the profile would
// just run fewer tests than it claims.
func TestProfileTestIDsExist(t *testing.T) {
	known := make(map[string]bool)
	for _, test := range tests.DefaultRegistry.List() {
		known[test.ID] = true
	}

	for id, profile := range Profiles {
		t.Run(id, func(t *testing.T) {
			if len(profile.TestIDs) == 0 {
				t.Fatalf("profile %q has no tests", id)
			}
			for _, testID := range profile.TestIDs {
				if !known[testID] {
					t.Errorf("profile %q names test %q, which is not in the registry", id, testID)
				}
			}
		})
	}
}

// TestProfileDescriptionsCarryNoTestCount keeps the counts out of the
// descriptions: they rot (connect said "6 tests" with 23 entries, frontend "5"
// with 5 but no room to grow) and say nothing about what a profile covers.
func TestProfileDescriptionsCarryNoTestCount(t *testing.T) {
	counts := regexp.MustCompile(`\b\d+\s+tests?\b`)
	for id, profile := range Profiles {
		if m := counts.FindString(profile.Description); m != "" {
			t.Errorf("profile %q description contains a test count (%q): %q", id, m, profile.Description)
		}
	}
}

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
