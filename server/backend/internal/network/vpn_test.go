package network

import (
	"net/netip"
	"testing"
)

func TestHexToIPv4(t *testing.T) {
	cases := []struct {
		hex  string
		want string
	}{
		{"01005564", "100.85.0.1"}, // Proton pvpnksintrf1 gateway, little-endian
		{"0101A8C0", "192.168.1.1"},
		{"00000000", ""}, // unspecified → empty
		{"", ""},
		{"123", ""}, // too short
	}
	for _, tc := range cases {
		if got := hexToIPv4(tc.hex); got != tc.want {
			t.Errorf("hexToIPv4(%q) = %q, want %q", tc.hex, got, tc.want)
		}
	}
}

func TestParseProcNetRoute(t *testing.T) {
	old := readFile
	defer func() { readFile = old }()

	readFile = func(_ string) ([]byte, error) {
		return []byte(`Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
pvpnksintrf1	00000000	01005564	0003	0	0	98	00000000	0	0	0
wlp0s20f0u3	00000000	0101A8C0	0003	0	0	600	00000000	0	0	0
wlp0s20f0u3	0A000000	00000000	0001	0	0	0	00FFFFFF	0	0	0
`), nil
	}

	entries, err := parseProcNetRoute()
	if err != nil {
		t.Fatalf("parseProcNetRoute: %v", err)
	}
	if len(entries) != 2 {
		t.Fatalf("expected 2 default routes, got %d: %+v", len(entries), entries)
	}
	if entries[0].Iface != "pvpnksintrf1" || entries[0].GatewayHex != "01005564" {
		t.Errorf("first entry = %+v, want pvpnksintrf1/01005564", entries[0])
	}
}

// TestDetectVPNInterfacePattern verifies the interface-name matching works for
// the Proton interfaces seen on real devices.
func TestDetectVPNInterfacePattern(t *testing.T) {
	for _, name := range []string{"proton0", "pvpnksintrf1", "wg5", "tun0", "tailscale0", "utun9"} {
		if !vpnInterfaceMatches(name) {
			t.Errorf("expected %q to match VPN patterns", name)
		}
	}
	for _, name := range []string{"wlan0", "eth0", "docker0", "br-1a981be1b563", "wlp0s20f0u3"} {
		if vpnInterfaceMatches(name) {
			t.Errorf("did not expect %q to match VPN patterns", name)
		}
	}
}

func TestVpnCGNATRangeDetectsProton(t *testing.T) {
	// 100.85.0.1/24 is Proton's kill-switch interface address.
	if !vpnCGNATRange.Contains(netip.MustParseAddr("100.85.0.1")) {
		t.Error("expected 100.85.0.1 to be in CGNAT/VPN range")
	}
	if vpnCGNATRange.Contains(netip.MustParseAddr("192.168.1.41")) {
		t.Error("did not expect 192.168.1.41 in CGNAT/VPN range")
	}
}

// detectVPNAvoidsNetCalls: DetectVPN on a machine without Proton should
// return nil/non-active without crashing (the interface scan finds nothing
// VPN-ish; the default route is a normal wifi NIC).
func TestDetectVPNNoVPNEnv(t *testing.T) {
	old := readFile
	defer func() { readFile = old }()

	// Simulate a clean home network: default route via wifi, no VPN ifaces.
	readFile = func(_ string) ([]byte, error) {
		return []byte(`Iface	Destination	Gateway 	Flags	RefCnt	Use	Metric	Mask		MTU	Window	IRTT
wlp0s20f0u3	00000000	0101A8C0	0003	0	0	600	00000000	0	0	0
`), nil
	}

	// The interface scan on THIS test machine may find real VPN ifaces, so
	// only assert the route-table path doesn't false-positive. The winning
	// default route is wifi → DefaultIF is never a VPN name.
	info := DetectVPN()
	if info != nil && info.DefaultIF != "" && vpnInterfaceMatches(info.DefaultIF) {
		t.Errorf("expected no VPN default-route match, got %+v", info)
	}
}
