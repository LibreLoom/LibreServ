package network

import (
	"strconv"
	"testing"
)

// newReport builds a NetworkReport with a small fluent helper.
type reportBuilder struct {
	r *NetworkReport
}

func rb() *reportBuilder {
	return &reportBuilder{r: &NetworkReport{}}
}

func (b *reportBuilder) v4Open() *reportBuilder { b.r.Stacks.V4.InboundOpen = true; return b }
func (b *reportBuilder) v6Open() *reportBuilder { b.r.Stacks.V6.InboundOpen = true; return b }
func (b *reportBuilder) cgnat() *reportBuilder  { b.r.NAT.BehindDoubleNAT = true; return b }
func (b *reportBuilder) upnpOn() *reportBuilder {
	b.r.UPnP.Discovered = true
	b.r.UPnP.Enabled = true
	return b
}
func (b *reportBuilder) upnpOff() *reportBuilder {
	b.r.UPnP.Discovered = true
	b.r.UPnP.Enabled = false
	return b
}
func (b *reportBuilder) dedIP() *reportBuilder { b.r.Connect.HasDedicatedIP = true; return b }
func (b *reportBuilder) tunnel() *reportBuilder {
	b.r.Connect.Active = true
	b.r.Connect.TunnelOK = true
	return b
}
func (b *reportBuilder) build() *NetworkReport { return b.r }

// req is a fluent Requirement builder.
type reqBuilder struct {
	req Requirement
}

func webReq() *reqBuilder { return &reqBuilder{req: Requirement{Web: true}} }
func mcReq() *reqBuilder {
	return &reqBuilder{req: Requirement{Ports: []PortNeed{
		{Protocol: "tcp", Port: 25565},
		{Protocol: "udp", Port: 25565},
	}}}
}

func (b *reqBuilder) largeUploads() *reqBuilder { b.req.LargeUploads = true; return b }
func (b *reqBuilder) build() Requirement        { return b.req }

// webEngine is an engine (report carries the Connect state now).
func webEngine() *Engine { return NewEngine(nil) }

func TestPlanWebMatrix(t *testing.T) {
	eng := webEngine()

	tests := []struct {
		name string
		req  Requirement
		rep  *NetworkReport
		want Path
	}{
		{"web, tunnel only → tunnel", webReq().build(), rb().tunnel().build(), PathTunnel},
		{"web, direct v4 verified → DIRECT (tunnel is fallback)", webReq().build(), rb().v4Open().tunnel().build(), PathDirectV4},
		{"web, large uploads + tunnel → LAN-only (never cloudflared)", webReq().largeUploads().build(), rb().tunnel().build(), PathLANOnly},
		{"web, direct v4 + large uploads → direct", webReq().largeUploads().build(), rb().v4Open().tunnel().build(), PathDirectV4},
		{"web, nothing → LAN-only", webReq().build(), rb().build(), PathLANOnly},
		{"web, v6 only verified → direct v6", webReq().build(), rb().v6Open().build(), PathDirectV6},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := eng.Plan(tt.req, tt.rep, nil)
			if got.Path != tt.want {
				t.Errorf("Plan() path = %s, want %s (msg=%q)", got.Path, tt.want, got.Message)
			}
		})
	}
}

func TestPlanPortsMatrix(t *testing.T) {
	eng := webEngine() // tunnel exists but never carries ports

	tests := []struct {
		name string
		req  Requirement
		rep  *NetworkReport
		want Path
	}{
		// Register #1: CGNAT + public v6 → v6 direct, not relay
		{"CGNAT + v6 open → direct v6", mcReq().build(), rb().cgnat().v6Open().build(), PathDirectV6},
		// Register #4: ISP blocks 80/443 → verify-driven (report shows closed) → tunnel/guide
		{"ports, no inbound, upnp on → upnp", mcReq().build(), rb().upnpOn().build(), PathUPnP},
		// Register #5: UPnP off → guide
		{"ports, upnp discovered off → guide", mcReq().build(), rb().upnpOff().build(), PathGuide},
		// Register #6: UPnP behind CGNAT → skip mapping branch → LAN/relay
		{"ports, cgnat + upnp on → NOT upnp (mapping useless)", mcReq().build(), rb().cgnat().upnpOn().build(), PathLANOnly},
		// Register #2: no public v6, CGNAT → LAN-only (relay addon needed)
		{"ports, cgnat no v6 → LAN-only + addon", mcReq().build(), rb().cgnat().build(), PathLANOnly},
		// Direct beats UPnP when verified
		{"ports, direct v4 + upnp → direct", mcReq().build(), rb().v4Open().upnpOn().build(), PathDirectV4},
		// Dedicated IP: relay when CGNAT and addon present
		{"ports, cgnat + dedicated IP → relay", mcReq().build(), rb().cgnat().dedIP().build(), PathRelay},
		// No direct, no UPnP, no addon → LAN-only
		{"ports, nothing → LAN-only", mcReq().build(), rb().build(), PathLANOnly},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := eng.Plan(tt.req, tt.rep, nil)
			if got.Path != tt.want {
				t.Errorf("Plan() path = %s, want %s (msg=%q)", got.Path, tt.want, got.Message)
			}
		})
	}
}

// TestPlanHysteresis verifies the N-failures-before-downgrade rule: a single
// transient failure never flips a healthy direct path off.
func TestPlanHysteresis(t *testing.T) {
	eng := webEngine()

	req := webReq().build()
	rep := rb().v4Open().tunnel().build()

	// Fresh state (no failures): direct wins.
	if p := eng.Plan(req, rep, nil); p.Path != PathDirectV4 {
		t.Fatalf("fresh state: path = %s, want direct_v4", p.Path)
	}

	// One failure: still direct (below threshold).
	st1 := map[Path]PathState{PathDirectV4: {ConsecutiveFailures: 1}}
	if p := eng.Plan(req, rep, st1); p.Path != PathDirectV4 {
		t.Fatalf("1 failure: path = %s, want direct_v4 (hysteresis)", p.Path)
	}

	// Two failures: still direct.
	st2 := map[Path]PathState{PathDirectV4: {ConsecutiveFailures: 2}}
	if p := eng.Plan(req, rep, st2); p.Path != PathDirectV4 {
		t.Fatalf("2 failures: path = %s, want direct_v4 (hysteresis)", p.Path)
	}

	// Three consecutive failures: downgrade to tunnel.
	st3 := map[Path]PathState{PathDirectV4: {ConsecutiveFailures: 3}}
	if p := eng.Plan(req, rep, st3); p.Path != PathTunnel {
		t.Fatalf("3 failures: path = %s, want cloudflared", p.Path)
	}
}

// TestPlanUpgrade verifies ShouldUpgrade: a fallback path needs M consecutive
// successes to move back to the preferred path.
func TestPlanUpgrade(t *testing.T) {
	if ShouldUpgrade(PathState{ConsecutiveSuccesses: 0}) {
		t.Error("0 successes should not upgrade")
	}
	if ShouldUpgrade(PathState{ConsecutiveSuccesses: 1}) {
		t.Error("1 success should not upgrade")
	}
	if !ShouldUpgrade(PathState{ConsecutiveSuccesses: 2}) {
		t.Error("2 successes should upgrade")
	}
}

// TestPlanPortCollision checks the engine surfaces both ports of a
// tcp+udp Minecraft requirement (register #3: per-app paths with collisions).
func TestPlanPortsPresent(t *testing.T) {
	eng := webEngine()
	p := eng.Plan(mcReq().build(), rb().upnpOn().build(), nil)
	if len(p.Ports) != 2 {
		t.Fatalf("ports = %v, want 2 (tcp+udp 25565)", p.Ports)
	}
	want := map[string]bool{"tcp/25565": false, "udp/25565": false}
	for _, pn := range p.Ports {
		want[pn.Protocol+"/"+strconv.Itoa(pn.Port)] = true
	}
	for k, v := range want {
		if !v {
			t.Errorf("missing port need %s in %+v", k, p.Ports)
		}
	}
}

// TestPlanWebNeverTunnelForLargeUploads is a direct check of the CF 100MB cap
// rule (register #16).
func TestPlanWebNeverTunnelForLargeUploads(t *testing.T) {
	eng := webEngine()
	p := eng.Plan(webReq().largeUploads().build(), rb().tunnel().build(), nil)
	if p.Path == PathTunnel {
		t.Fatalf("large_uploads app routed through cloudflared: %s", p.Path)
	}
}

// TestPlanLargeUploadsCGNAT verifies defect-6 fix: a large-uploads web app
// on CGNAT with a dedicated IP goes to the relay, not LAN-only.
func TestPlanLargeUploadsCGNAT(t *testing.T) {
	eng := webEngine()

	// CGNAT + dedicated IP + large uploads → relay (cloudflared is barred).
	rep := rb().cgnat().dedIP().build()
	p := eng.Plan(webReq().largeUploads().build(), rep, nil)
	if p.Path != PathRelay {
		t.Fatalf("path = %s, want frp (large-uploads web on CGNAT with dedicated IP)", p.Path)
	}

	// CGNAT + large uploads + NO dedicated IP → LAN-only + upsell.
	p2 := eng.Plan(webReq().largeUploads().build(), rb().cgnat().build(), nil)
	if p2.Path != PathLANOnly || !p2.AddonNeeded {
		t.Fatalf("path = %s addon=%v, want lan_only addon=true", p2.Path, p2.AddonNeeded)
	}
}

// TestPlanWebPerStackHysteresis verifies defect-7 fix: v4 failing 3x does not
// kill a healthy v6 direct path.
func TestPlanWebPerStackHysteresis(t *testing.T) {
	eng := webEngine()
	req := webReq().build()

	// v6 verified open, v4 degraded: still direct via v6 (v4's degradation
	// must not kill the healthy v6 stack).
	rep := rb().v6Open().tunnel().build()
	st := map[Path]PathState{
		PathDirectV4: {ConsecutiveFailures: 5},
	}
	p := eng.Plan(req, rep, st)
	if p.Path != PathDirectV6 {
		t.Fatalf("path = %s, want direct_v6 (v6 healthy despite v4 degraded)", p.Path)
	}
	if !p.CoverageV6 {
		t.Error("coverage_v6 should be true (v6 verified)")
	}
	if p.CoverageV4 {
		t.Error("coverage_v4 should be false (v4 degraded)")
	}
}
