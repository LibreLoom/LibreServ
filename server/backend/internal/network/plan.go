package network

import (
	"fmt"
	"strings"
)

// Path identifies one exposure mechanism for an app.
type Path string

const (
	PathDirectV4 Path = "direct_v4"
	PathDirectV6 Path = "direct_v6"
	PathUPnP     Path = "upnp"
	PathGuide    Path = "guide_upnp"
	PathTunnel   Path = "cloudflared"
	PathRelay    Path = "frp"
	PathLANOnly  Path = "lan_only"
)

// PathState carries the verify history the engine needs for hysteresis.
// Consecutive counters are per app×path×protocol×port (one row in path_state).
type PathState struct {
	ConsecutiveFailures  int    `json:"consecutive_failures"`
	ConsecutiveSuccesses int    `json:"consecutive_successes"`
	LastFailureReason    string `json:"last_failure_reason,omitempty"`
	LastVerifiedAt       int64  `json:"last_verified_at,omitempty"`
}

// Plan is the decision engine's output for one app.
type Plan struct {
	Path        Path       `json:"path"`
	Steps       []string   `json:"steps"`           // executable actions, in order
	CoverageV4  bool       `json:"coverage_v4"`     // IPv4 visitors reachable
	CoverageV6  bool       `json:"coverage_v6"`     // IPv6 visitors reachable
	Message     string     `json:"message"`         // plain-language, for the UI
	AddonNeeded bool       `json:"addon_needed"`    // → upsell dedicated IP
	Ports       []PortNeed `json:"ports,omitempty"` // protocol-aware ports the plan opens/exposes
}

// Hysteresis thresholds — N consecutive failures before downgrade, M before
// upgrade. Prevents path oscillation on transient ISP hiccups.
const (
	DowngradeAfterFailures = 3
	UpgradeAfterSuccesses  = 2
)

// Engine holds the decision engine's dependencies. Connect state is read from
// each NetworkReport (the single source of truth per decision), not captured
// at construction.
type Engine struct {
	upnp *UPnPClient
}

func NewEngine(upnp *UPnPClient) *Engine {
	return &Engine{upnp: upnp}
}

// Requirement is the engine's own app-access boundary type, decoupled from
// the apps package (apps imports network; network cannot import apps).
// Callers adapt the catalog's Access schema into this.
type Requirement struct {
	Web          bool
	Ports        []PortNeed
	LargeUploads bool
}

// PortNeed is one direct-port requirement, mirroring the catalog schema.
type PortNeed struct {
	Protocol   string `json:"protocol"` // "tcp" | "udp" | "both"
	Port       int    `json:"port"`
	VerifyHint string `json:"verify_hint,omitempty"`
}

// Plan decides the exposure path for one app. state is the app×path verify
// history used for hysteresis — the engine never flips paths on a single
// transient failure.
func (e *Engine) Plan(req Requirement, report *NetworkReport, state map[Path]PathState) *Plan {
	// Web-only apps: direct (verified) → cloudflared → LAN-only. Direct first:
	// routing verified-direct traffic through a tunnel bills users against
	// their tunnel_gb quota for a worse path (CF ToS 2.8 for non-HTML).
	if req.Web && len(req.Ports) == 0 {
		return e.planWeb(req, report, state)
	}
	return e.planPorts(req, report, state)
}

// planWeb decides web-only apps.
func (e *Engine) planWeb(req Requirement, report *NetworkReport, state map[Path]PathState) *Plan {
	// Large uploads never go through cloudflared (CF free-tier 100MB cap).
	// Direct is preferred when verified; the tunnel is the fallback, and the
	// relay (dedicated IP) is the CGNAT path for large-uploads web apps.
	tunnelUsable := !req.LargeUploads && report.Connect.Active && report.Connect.TunnelOK

	// Per-stack hysteresis: each stack degrades independently. v4 failing 3×
	// must not kill a healthy v6 direct path.
	v4OK := report.Stacks.V4.InboundOpen && !downgraded(state[PathDirectV4])
	v6OK := report.Stacks.V6.InboundOpen && !downgraded(state[PathDirectV6])
	if v4OK || v6OK {
		return &Plan{
			Path:       PathDirectV4,
			CoverageV4: v4OK,
			CoverageV6: v6OK,
			Message:    "Your app is reachable directly from the internet.",
		}
	}
	if tunnelUsable {
		return &Plan{
			Path:       PathTunnel,
			CoverageV4: true,
			CoverageV6: true,
			Message:    "Your app is reachable from the internet through a protected connection.",
		}
	}
	// Large-uploads web apps can't use cloudflared; if the network is
	// CGNAT/double-NAT, the dedicated-IP relay is the path.
	if req.LargeUploads && (report.NAT.BehindDoubleNAT || report.NAT.Type == NATCGNAT) {
		return e.planCGNAT(req, report, nil, state)
	}
	return &Plan{
		Path:    PathLANOnly,
		Message: "Only people on your home network can use this app right now.",
	}
}

// planPorts decides apps that need direct TCP/UDP ports.
func (e *Engine) planPorts(req Requirement, report *NetworkReport, state map[Path]PathState) *Plan {
	// Collect the protocol-aware port needs (tcp+udp on the same port stay
	// distinct — an actuator needs the protocol to create the right mapping).
	ports := req.Ports

	// 1. Direct exposure (v6 first when it verifies — it needs no port
	//    mapping and survives CGNAT).
	v6Open := report.Stacks.V6.InboundOpen
	v4Open := report.Stacks.V4.InboundOpen
	if v6Open && !downgraded(state[PathDirectV6]) {
		return &Plan{
			Path:       PathDirectV6,
			CoverageV4: v4Open,
			CoverageV6: true,
			Ports:      ports,
			Message:    "Your apps are reachable over the internet directly.",
		}
	}
	if v4Open && !downgraded(state[PathDirectV4]) {
		return &Plan{
			Path:       PathDirectV4,
			CoverageV4: true,
			CoverageV6: v6Open,
			Ports:      ports,
			Message:    "Your apps are reachable over the internet directly.",
		}
	}

	// 2. UPnP when the router has it enabled — never when behind CGNAT
	//    (WAN-vs-STUN comparison says a mapping would be useless).
	if report.NAT.BehindDoubleNAT {
		return e.planCGNAT(req, report, ports, state)
	}
	if report.UPnP.Discovered && report.UPnP.Enabled && !downgraded(state[PathUPnP]) {
		return &Plan{
			Path:       PathUPnP,
			CoverageV4: true,
			CoverageV6: report.Stacks.V6.InboundOpen,
			Ports:      ports,
			Message:    "We opened the ports your apps need on your router.",
			Steps:      []string{fmt.Sprintf("Open ports %s on your router using UPnP", joinPorts(ports))},
		}
	}
	if report.UPnP.Discovered && !report.UPnP.Enabled {
		return &Plan{
			Path:    PathGuide,
			Ports:   ports,
			Message: "Your router has the setting that lets apps be reached from the internet — it just needs to be turned on.",
			Steps:   []string{"Enable UPnP on your router (we'll show you where)"},
		}
	}

	return e.planCGNAT(req, report, ports, state)
}

// planCGNAT handles the "no direct, no UPnP" bucket: CGNAT/symmetric/double
// NAT — the relay add-on or LAN-only.
func (e *Engine) planCGNAT(req Requirement, report *NetworkReport, ports []PortNeed, state map[Path]PathState) *Plan {
	if report.Connect.HasDedicatedIP && !downgraded(state[PathRelay]) {
		return &Plan{
			Path:        PathRelay,
			CoverageV4:  true,
			CoverageV6:  true,
			Ports:       ports,
			Message:     "Your apps are reachable from the internet through your dedicated address.",
			AddonNeeded: false,
		}
	}
	return &Plan{
		Path:        PathLANOnly,
		Ports:       ports,
		Message:     "Only people on your home network can use these apps right now.",
		AddonNeeded: true, // upsell: a dedicated address would fix this
	}
}

// downgraded reports whether a path has failed verification enough times to
// be considered degraded (hysteresis: N consecutive failures).
func downgraded(states ...PathState) bool {
	for _, s := range states {
		if s.ConsecutiveFailures >= DowngradeAfterFailures {
			return true
		}
	}
	return false
}

// ShouldUpgrade reports whether a fallback path has proven stable enough to
// move back to the preferred path (M consecutive successes).
func ShouldUpgrade(state PathState) bool {
	return state.ConsecutiveSuccesses >= UpgradeAfterSuccesses
}

func joinPorts(ports []PortNeed) string {
	seen := map[string]bool{}
	var parts []string
	for _, p := range ports {
		key := fmt.Sprintf("%s/%d", p.Protocol, p.Port)
		if seen[key] {
			continue
		}
		seen[key] = true
		proto := p.Protocol
		if proto == "" {
			proto = "tcp"
		}
		parts = append(parts, fmt.Sprintf("%s %d", proto, p.Port))
	}
	return strings.Join(parts, ", ")
}
