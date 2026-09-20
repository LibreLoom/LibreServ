package network

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"net/netip"
	"time"
)

// Stack reports the state of one address family (IPv4 / IPv6).
type Stack struct {
	Available      bool   `json:"available"`             // device has a usable address of this family
	PublicAddr     string `json:"public_addr,omitempty"` // v4 public or v6 GUA
	InboundOpen    bool   `json:"inbound_open"`          // verified reachable from outside
	InboundChecked bool   `json:"inbound_checked"`       // true once an external probe ran
}

// DomainState describes the device's public naming.
type DomainState struct {
	Source string `json:"source"` // "none" | "connect_subdomain" | "own"
	Name   string `json:"name,omitempty"`
}

// ConnectState describes the Connect integration status.
type ConnectState struct {
	Active         bool `json:"active"`
	HasDedicatedIP bool `json:"has_dedicated_ip"`
	TunnelOK       bool `json:"tunnel_ok"`
}

// NetworkReport is one diagnostic snapshot of the device's reachability.
// inbound_open values are only ever set by external verification; the
// device-side generator marks them InboundChecked=false and lets the engine
// decide whether they can be asserted.
type NetworkReport struct {
	GeneratedAt int64 `json:"generated_at"`

	Stacks struct {
		V4 Stack `json:"v4"`
		V6 Stack `json:"v6"`
	} `json:"stacks"`

	NAT struct {
		Type            NATType `json:"type"`
		BehindDoubleNAT bool    `json:"behind_double_nat"`
		PublicIP        string  `json:"public_ip,omitempty"`
		RouterWANIP     string  `json:"router_wan_ip,omitempty"`
	} `json:"nat"`

	UPnP UPnPStatus `json:"upnp"`

	Connect ConnectState `json:"connect"`
	Domain  DomainState  `json:"domain"`

	// Headline is the one plain-language sentence the UI leads with.
	Headline string `json:"headline"`
}

// ReportInputs are the externally-provided facts the generator combines with
// its own probing.
type ReportInputs struct {
	Connect ConnectState
	Domain  DomainState
	// VerifyHooks let the engine fill inbound_checked for paths it can probe.
	VerifyV4 func(ctx context.Context, addr string) (bool, error)
	VerifyV6 func(ctx context.Context, addr string) (bool, error)
}

// GenerateNetworkReport probes the device and assembles a NetworkReport.
// The WAN IP comparison fixes CGNAT detection (STUN-only never fires).
func GenerateNetworkReport(ctx context.Context, upnp *UPnPClient, inputs ReportInputs, logger *slog.Logger) (*NetworkReport, error) {
	if upnp == nil {
		upnp = NewUPnPClient(logger)
	}

	report := &NetworkReport{GeneratedAt: time.Now().Unix()}

	// ── NAT classification ──
	natRes, err := DetectNATType(ctx)
	if err == nil && natRes != nil {
		report.NAT.Type = natRes.Type
		report.NAT.PublicIP = natRes.PublicIP.String()
	}

	// ── UPnP discovery + WAN IP → reliable CGNAT signal ──
	upnpStatus, err := upnp.Status(ctx)
	if err == nil && upnpStatus != nil {
		report.UPnP = *upnpStatus
		if upnpStatus.WANIP != "" {
			report.NAT.RouterWANIP = upnpStatus.WANIP
			if wanAddr, perr := netip.ParseAddr(upnpStatus.WANIP); perr == nil && natRes != nil {
				report.NAT.BehindDoubleNAT = DetectCGNAT(wanAddr, natRes.PublicIP)
				if report.NAT.BehindDoubleNAT {
					report.NAT.Type = NATCGNAT
				}
			}
		}
	}

	// ── IPv4 stack ──
	if v4, ok := localIPv4(); ok {
		report.Stacks.V4.Available = true
		report.Stacks.V4.PublicAddr = v4.String()
	}
	if report.NAT.PublicIP != "" {
		report.Stacks.V4.Available = true
		report.Stacks.V4.PublicAddr = report.NAT.PublicIP
	}
	if inputs.VerifyV4 != nil && report.Stacks.V4.PublicAddr != "" {
		ok, err := inputs.VerifyV4(ctx, report.Stacks.V4.PublicAddr)
		if err != nil {
			// Probe didn't run (auth/rate-limit/outage): leave state
			// untouched — "unknown" stays distinct from "verified closed".
			slog.Warn("v4 verify probe failed", "error", err)
		} else {
			// InboundChecked is set on any REAL probe outcome: "verified
			// closed" is distinct from "never checked".
			report.Stacks.V4.InboundChecked = true
			if ok {
				report.Stacks.V4.InboundOpen = true
			}
		}
	}

	// ── IPv6 stack ──
	if v6, ok := localIPv6GUA(); ok {
		report.Stacks.V6.Available = true
		report.Stacks.V6.PublicAddr = v6.String()
	}
	if inputs.VerifyV6 != nil && report.Stacks.V6.PublicAddr != "" {
		ok, err := inputs.VerifyV6(ctx, report.Stacks.V6.PublicAddr)
		if err != nil {
			slog.Warn("v6 verify probe failed", "error", err)
		} else {
			report.Stacks.V6.InboundChecked = true
			if ok {
				report.Stacks.V6.InboundOpen = true
			}
		}
	}

	// ── Connect + domain ──
	report.Connect = inputs.Connect
	report.Domain = inputs.Domain

	report.Headline = buildHeadline(report)
	return report, nil
}

// localIPv4 returns the device's LAN IPv4 address.
func localIPv4() (netip.Addr, bool) {
	conn, err := net.Dial("udp4", "8.8.8.8:53")
	if err != nil {
		return netip.Addr{}, false
	}
	defer conn.Close()
	addr := conn.LocalAddr().(*net.UDPAddr)
	if ip := addr.IP; ip != nil {
		return netip.AddrFrom4([4]byte(ip.To4())), true
	}
	return netip.Addr{}, false
}

// localIPv6GUA returns a global unicast IPv6 address of the device, preferring
// the stable (privacy-safe) one when available.
func localIPv6GUA() (netip.Addr, bool) {
	addrs, err := net.InterfaceAddrs()
	if err != nil {
		return netip.Addr{}, false
	}
	var best netip.Addr
	for _, a := range addrs {
		ipnet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		addr, ok := netip.AddrFromSlice(ipnet.IP)
		if !ok || !addr.Is6() || addr.IsLinkLocalUnicast() || addr.IsLoopback() || addr.IsPrivate() {
			continue
		}
		// Global unicast.
		if best.IsValid() {
			continue // keep the first stable one; InterfaceAddrs is stable order
		}
		best = addr
	}
	return best, best.IsValid()
}

// buildHeadline produces the one plain-language sentence for the UI.
func buildHeadline(r *NetworkReport) string {
	open := r.Stacks.V4.InboundOpen || r.Stacks.V6.InboundOpen
	tunnel := r.Connect.Active && r.Connect.TunnelOK

	switch {
	case tunnel:
		return "Your apps are reachable from the internet."
	case open && r.Stacks.V4.InboundOpen && r.Stacks.V6.InboundOpen:
		return "Your apps are reachable from the internet on both network types."
	case open:
		// Inbound is verified open on at least one stack — reachable even
		// without a friendly domain name yet.
		return "Your apps are reachable from the internet."
	case r.NAT.BehindDoubleNAT || r.NAT.Type == NATCGNAT:
		return "Your network shares an internet address with others, so apps can't be reached directly from outside."
	case r.UPnP.Discovered && !r.UPnP.Enabled:
		return "Your router has the setting that lets apps be reached from the internet — it just needs to be turned on."
	case !r.UPnP.Discovered:
		return "Only people on your home network can use your apps right now."
	default:
		return "Only people on your home network can use your apps right now."
	}
}

// String implements fmt.Stringer for debugging.
func (r *NetworkReport) String() string {
	return fmt.Sprintf("NetworkReport{stacks: v4=%s v6=%s, nat=%s, upnp=%v, headline=%q}",
		r.Stacks.V4.PublicAddr, r.Stacks.V6.PublicAddr, r.NAT.Type, r.UPnP.Discovered, r.Headline)
}
