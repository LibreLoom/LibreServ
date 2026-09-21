package network

import (
	"context"
	"log/slog"
	"net/netip"
	"testing"
)

func testLogger() *slog.Logger {
	return slog.New(slog.DiscardHandler)
}

// TestHeadline builds a report directly and checks the plain-language headline.
func TestHeadline(t *testing.T) {
	tests := []struct {
		name  string
		build func() *NetworkReport
		want  string
	}{
		{
			name: "tunnel active → reachable",
			build: func() *NetworkReport {
				r := &NetworkReport{}
				r.Connect.Active = true
				r.Connect.TunnelOK = true
				return r
			},
			want: "Your apps are reachable from the internet.",
		},
		{
			name: "both stacks verified → reachable on both",
			build: func() *NetworkReport {
				r := &NetworkReport{}
				r.Stacks.V4.InboundOpen = true
				r.Stacks.V6.InboundOpen = true
				return r
			},
			want: "Your apps are reachable from the internet on both network types.",
		},
		{
			name: "v4 only verified with name → reachable",
			build: func() *NetworkReport {
				r := &NetworkReport{}
				r.Stacks.V4.InboundOpen = true
				r.Domain.Name = "apps.example.com"
				return r
			},
			want: "Your apps are reachable from the internet.",
		},
		{
			name: "CGNAT → shared address explanation",
			build: func() *NetworkReport {
				r := &NetworkReport{}
				r.NAT.BehindDoubleNAT = true
				return r
			},
			want: "Your network shares an internet address with others, so apps can't be reached directly from outside.",
		},
		{
			name: "UPnP found but disabled → router setting hint",
			build: func() *NetworkReport {
				r := &NetworkReport{}
				r.UPnP.Discovered = true
				r.UPnP.Enabled = false
				return r
			},
			want: "Your router has the setting that lets apps be reached from the internet — it just needs to be turned on.",
		},
		{
			name:  "nothing → LAN only",
			build: func() *NetworkReport { return &NetworkReport{} },
			want:  "Only people on your home network can use your apps right now.",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := tt.build()
			if got := buildHeadline(r); got != tt.want {
				t.Errorf("buildHeadline() = %q, want %q", got, tt.want)
			}
		})
	}
}

// TestGenerateNetworkReportVerifyHooks verifies that inbound_open is only set
// when the external verify hook confirms it, and never by self-assessment.
func TestGenerateNetworkReportVerifyHooks(t *testing.T) {
	ctx := context.Background()
	logger := testLogger()
	upnp := NewUPnPClient(logger)

	t.Run("verify hook confirms v4", func(t *testing.T) {
		inputs := ReportInputs{
			VerifyV4: func(ctx context.Context, addr string) (bool, error) { return true, nil },
		}
		r, err := GenerateNetworkReport(ctx, upnp, inputs, logger)
		if err != nil {
			t.Fatalf("GenerateNetworkReport: %v", err)
		}
		if !r.Stacks.V4.InboundChecked || !r.Stacks.V4.InboundOpen {
			t.Errorf("expected v4 inbound checked+open, got %+v", r.Stacks.V4)
		}
	})

	t.Run("verify hook denies v4", func(t *testing.T) {
		inputs := ReportInputs{
			VerifyV4: func(ctx context.Context, addr string) (bool, error) { return false, nil },
		}
		r, err := GenerateNetworkReport(ctx, upnp, inputs, logger)
		if err != nil {
			t.Fatalf("GenerateNetworkReport: %v", err)
		}
		if r.Stacks.V4.InboundOpen {
			t.Errorf("expected v4 inbound NOT open when verify denies, got %+v", r.Stacks.V4)
		}
	})

	t.Run("no hook → inbound not asserted", func(t *testing.T) {
		r, err := GenerateNetworkReport(ctx, upnp, ReportInputs{}, logger)
		if err != nil {
			t.Fatalf("GenerateNetworkReport: %v", err)
		}
		if r.Stacks.V4.InboundChecked {
			t.Error("expected InboundChecked=false with no verify hook")
		}
	})
}

// TestDetectCGNATIntegration checks the report marks CGNAT from a WAN IP that
// differs from the STUN egress (the reliable signal, per the review).
func TestDetectCGNATIntegration(t *testing.T) {
	// Pure logic path: DetectCGNAT with a CGNAT-range WAN must return true.
	// (STUN network probing is not part of this unit test.)
	if !DetectCGNAT(netip.MustParseAddr("100.64.0.2"), netip.MustParseAddr("203.0.113.10")) {
		t.Error("expected CGNAT detection for RFC6598 WAN")
	}
	if DetectCGNAT(netip.MustParseAddr("203.0.113.10"), netip.MustParseAddr("203.0.113.10")) {
		t.Error("did not expect CGNAT for public WAN == egress")
	}
}
