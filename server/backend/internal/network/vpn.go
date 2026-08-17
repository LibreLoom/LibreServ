package network

import (
	"fmt"
	"net"
	"net/netip"
	"os"
	"strings"
)

// VPN interface name patterns. Common Linux VPN clients (Proton, WireGuard,
// OpenVPN, Tailscale, ZeroTier, NordLynx, OpenConnect, etc.) all use
// recognizable names. A match means the device's default route — and hence
// STUN/UPnP probe traffic — may be going through the tunnel, which makes
// NAT classification unreliable (see DetectedVPN doc).
var vpnInterfacePatterns = []string{
	"proton", "pvpn", // Proton VPN (incl. kill-switch iface)
	"wg", "wireguard", // WireGuard / NordLynx / Mullvad
	"tun", "tap", // OpenVPN / generic
	"tailscale", "ts", // Tailscale
	"zerotier", "zt", // ZeroTier
	"nordl", "nordlynx", // NordVPN
	"openvpn", "ovpn", // OpenVPN
	"cscotun",     // Cisco AnyConnect
	"ppp", "pptp", // PPP / PPTP
	"utun",                // macOS userspace tunnels
	"ipsec", "strongswan", // IPsec
	"windscribe",       // Windscribe
	"surfshark", "sfs", // Surfshark
}

// VPNInterfacePatterns is a private tunnel range.
// 100.64.0.0/10 is CGNAT (RFC 6598) but VPNs like Proton reuse it for their
// internal link.
var vpnCGNATRange = netip.MustParsePrefix("100.64.0.0/10")

// vpnInterfaceMatches reports whether an interface name looks like a VPN
// tunnel interface. Used by DetectVPN (names) and the default-route check.
func vpnInterfaceMatches(name string) bool {
	name = strings.ToLower(name)
	for _, p := range vpnInterfacePatterns {
		if strings.Contains(name, p) {
			return true
		}
	}
	return false
}

// VPNInfo describes an active VPN tunnel on the device, if any.
type VPNInfo struct {
	Active      bool     `json:"active"`
	Interfaces  []string `json:"interfaces,omitempty"`
	Names       []string `json:"names,omitempty"`
	DefaultVia  string   `json:"default_via,omitempty"`
	DefaultIF   string   `json:"default_if,omitempty"`
	Description string   `json:"description,omitempty"`
}

// DetectVPN scans the local interfaces and route table for tunnel interfaces.
// The list of names is a best-effort heuristic — it can't be exhaustive, so
// we also flag any interface with an address in 100.64.0.0/10 (CGNAT range
// reused by Proton/other VPNs for their internal link).
//
// The default route check adds signal: when a VPN is up, its tunnel or
// kill-switch interface is usually the default route (Proton's pvpnksintrf1
// shows exactly this). When both the default route and a named interface
// agree, the detection is reliable.
//
// A nil return means no VPN detected.
func DetectVPN() *VPNInfo {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}

	info := &VPNInfo{Active: false}
	for _, ifc := range ifaces {
		name := strings.ToLower(ifc.Name)
		matchedPattern := false
		for _, p := range vpnInterfacePatterns {
			if strings.Contains(name, p) {
				matchedPattern = true
				break
			}
		}
		if !matchedPattern {
			continue
		}
		info.Interfaces = append(info.Interfaces, ifc.Name)

		// Address within CGNAT range is the strongest VPN identifier.
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip == nil {
				continue
			}
			if addr, ok := netip.AddrFromSlice(ip); ok {
				if vpnCGNATRange.Contains(addr.Unmap()) {
					info.Active = true
					info.Names = append(info.Names, ifc.Name)
				}
			}
		}
	}

	// Default route via a VPN-ish interface (Proton kill-switch).
	if defIF, defIP, err := defaultRouteInterface(); err == nil {
		if strings.HasPrefix(defIF, "proton") || strings.HasPrefix(defIF, "pvpn") || strings.HasPrefix(defIF, "wg") || strings.HasPrefix(defIF, "tun") || strings.HasPrefix(defIF, "tap") || strings.HasPrefix(defIF, "tailscale") || strings.HasPrefix(defIF, "zerotier") || strings.HasPrefix(defIF, "utun") || strings.HasPrefix(defIF, "cscotun") {
			info.Active = true
			info.DefaultVia = defIP
			info.DefaultIF = defIF
		}
	}

	info.Description = describeVPN(info)
	return info
}

// describeVPN summarizes the detection for the frontend / logs.
func describeVPN(v *VPNInfo) string {
	if !v.Active {
		return ""
	}
	if len(v.Interfaces) > 0 {
		return "A VPN tunnel is active on this device (" + strings.Join(v.Interfaces, ", ") + ")."
	}
	if v.DefaultIF != "" {
		return "Traffic is routed through " + v.DefaultIF + ", which looks like a VPN."
	}
	return "A VPN tunnel appears to be active on this device."
}

// defaultRouteInterface returns the interface name and gateway of the
// default route (IPv4, first match).
func defaultRouteInterface() (string, string, error) {
	// net.InterfaceByName exists but we need the route table. Parse /proc/net/route
	// (Linux) — no external deps.
	entries, err := parseProcNetRoute()
	if err != nil {
		return "", "", err
	}
	if len(entries) == 0 {
		return "", "", nil
	}
	e := entries[0]
	// hex gateway to dotted quad
	gw := hexToIPv4(e.GatewayHex)
	return e.Iface, gw, nil
}

type routeEntry struct {
	Iface      string
	GatewayHex string
}

// parseProcNetRoute reads /proc/net/route and returns the default routes
// (destination 0.0.0.0), best (lowest metric) first.
func parseProcNetRoute() ([]routeEntry, error) {
	data, err := readFile("/proc/net/route")
	if err != nil {
		return nil, err
	}
	lines := strings.Split(string(data), "\n")
	var entries []routeEntry
	for _, line := range lines[1:] { // skip header
		fields := strings.Fields(line)
		if len(fields) < 4 {
			continue
		}
		if fields[1] != "00000000" { // destination == 0.0.0.0
			continue
		}
		entries = append(entries, routeEntry{Iface: fields[0], GatewayHex: fields[2]})
	}
	return entries, nil
}

// hexToIPv4 converts a little-endian hex IPv4 (as in /proc/net/route) to a
// dotted-quad string. Empty/0.0.0.0 returns "".
func hexToIPv4(hex string) string {
	if len(hex) != 8 {
		return ""
	}
	// /proc/net/route is little-endian within the 4 bytes (host byte
	// order stored in memory), so reverse the byte pairs.
	var b [4]byte
	for i := 0; i < 4; i++ {
		pair := hex[2*(3-i) : 2*(3-i)+2]
		var v byte
		if _, err := fmt.Sscanf(pair, "%02x", &v); err != nil {
			return ""
		}
		b[i] = v
	}
	ip := net.IPv4(b[0], b[1], b[2], b[3])
	if ip.IsUnspecified() {
		return ""
	}
	return ip.String()
}

// readFile allows swapping in tests (avoiding direct /proc reads).
var readFile = func(path string) ([]byte, error) {
	return os.ReadFile(path)
}
