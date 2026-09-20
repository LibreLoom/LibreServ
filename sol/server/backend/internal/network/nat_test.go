package network

import (
	"net/netip"
	"testing"
)

func TestDetectCGNAT(t *testing.T) {
	wan := func(s string) netip.Addr { return netip.MustParseAddr(s) }

	tests := []struct {
		name     string
		wanIP    netip.Addr
		publicIP netip.Addr
		want     bool
	}{
		{
			name:     "equal public WAN and egress — no NAT",
			wanIP:    wan("203.0.113.10"),
			publicIP: wan("203.0.113.10"),
			want:     false,
		},
		{
			name:     "RFC1918 WAN with public egress — double NAT",
			wanIP:    wan("192.168.1.1"),
			publicIP: wan("203.0.113.10"),
			want:     true,
		},
		{
			name:     "RFC6598 WAN with public egress — carrier-grade NAT",
			wanIP:    wan("100.64.0.2"),
			publicIP: wan("203.0.113.10"),
			want:     true,
		},
		{
			name:     "public WAN differs from egress — nested NAT",
			wanIP:    wan("198.51.100.5"),
			publicIP: wan("203.0.113.10"),
			want:     true,
		},
		{
			name:     "CGNAT-range WAN in egress too — CGNAT",
			wanIP:    wan("100.64.0.2"),
			publicIP: wan("100.127.255.254"),
			want:     true,
		},
		{
			name:     "invalid WAN — cannot tell, not CGNAT",
			wanIP:    netip.Addr{},
			publicIP: wan("203.0.113.10"),
			want:     false,
		},
		{
			name:     "IPv6 public — no CGNAT",
			wanIP:    wan("2001:db8::1"),
			publicIP: wan("2001:db8::1"),
			want:     false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := DetectCGNAT(tt.wanIP, tt.publicIP); got != tt.want {
				t.Errorf("DetectCGNAT(%v, %v) = %v, want %v", tt.wanIP, tt.publicIP, got, tt.want)
			}
		})
	}
}
