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
