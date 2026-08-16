package network

import (
	"context"
	"fmt"
	"net"
	"net/netip"
	"time"

	"github.com/pion/stun"
)

type NATType string

const (
	NATOpen           NATType = "open"
	NATFullCone       NATType = "full_cone"
	NATRestricted     NATType = "restricted"
	NATPortRestricted NATType = "port_restricted"
	NATSymmetric      NATType = "symmetric"
	NATCGNAT          NATType = "cgnat"
	NATBlocked        NATType = "blocked"
)

type NATResult struct {
	Type            NATType    `json:"type"`
	PublicIP        netip.Addr `json:"public_ip"`
	LocalIP         netip.Addr `json:"local_ip"`
	Details         string     `json:"details,omitempty"`
	BehindDoubleNAT bool       `json:"behind_double_nat"`
}

var stunServers = []string{
	"stun.l.google.com:19302",
	"stun.cloudflare.com:3478",
	"stun.services.mozilla.com:3478",
}

// DetectNATType classifies NAT via STUN alone. NOTE: the STUN-only path
// cannot reliably detect CGNAT — STUN returns the CGNAT's *outer* egress,
// which is a normal public IP, so isCGNAT(publicIP) below essentially never
// fires. Use DetectNATTypeFromWAN once the router's WAN IP is known (UPnP
// GetExternalIPAddress); it re-classifies with a reliable WAN-vs-STUN
// comparison.
func DetectNATType(ctx context.Context) (*NATResult, error) {
	localIP, err := getLocalIP()
	if err != nil {
		return nil, fmt.Errorf("get local IP: %w", err)
	}

	publicIP, err := DetectPublicIP(ctx)
	if err != nil {
		return &NATResult{
			Type:    NATBlocked,
			LocalIP: localIP,
			Details: "Cannot reach STUN servers - UDP may be blocked",
		}, nil
	}

	if publicIP.IsPrivate() {
		return &NATResult{
			Type:     NATBlocked,
			PublicIP: publicIP,
			LocalIP:  localIP,
			Details:  "Public IP is actually private - network misconfiguration",
		}, nil
	}

	if isCGNAT(publicIP) {
		// Kept as a defensive check: fires only when the STUN egress itself
		// falls in 100.64/10, which is rare (see DetectNATType doc comment).
		return &NATResult{
			Type:     NATCGNAT,
			PublicIP: publicIP,
			LocalIP:  localIP,
			Details:  "Carrier-Grade NAT detected (ISP shares IP among customers)",
		}, nil
	}

	if publicIP == localIP {
		return &NATResult{
			Type:     NATOpen,
			PublicIP: publicIP,
			LocalIP:  localIP,
			Details:  "Direct public IP - no NAT",
		}, nil
	}

	natType, err := detectNATBehavior(ctx, localIP, publicIP)
	if err != nil {
		return &NATResult{
			Type:     NATBlocked,
			PublicIP: publicIP,
			LocalIP:  localIP,
			Details:  fmt.Sprintf("NAT detection failed: %v", err),
		}, nil
	}

	return &NATResult{
		Type:     natType,
		PublicIP: publicIP,
		LocalIP:  localIP,
	}, nil
}

// DetectCGNAT reports whether the device sits behind carrier-grade or double
// NAT, comparing the router's WAN address (UPnP GetExternalIPAddress or the
// router-reported WAN) against the STUN-observed public egress IP.
// True when the WAN is RFC1918/ULA (double NAT), in 100.64/10 (RFC 6598
// carrier-grade space), or differs from the public egress (NAT in between).
func DetectCGNAT(wanIP, publicIP netip.Addr) bool {
	if !wanIP.IsValid() || !publicIP.IsValid() {
		return false // can't tell without both addresses
	}
	if wanIP.IsPrivate() || isCGNAT(wanIP) {
		return true
	}
	return wanIP != publicIP
}

func isCGNAT(ip netip.Addr) bool {
	if !ip.Is4() {
		return false
	}
	ip4 := ip.As4()
	return ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127
}

func getLocalIP() (netip.Addr, error) {
	conn, err := net.Dial("udp4", stunServers[0])
	if err != nil {
		return netip.Addr{}, err
	}
	defer conn.Close()

	localAddr := conn.LocalAddr().(*net.UDPAddr)
	addr, ok := netip.AddrFromSlice(localAddr.IP)
	if !ok {
		return netip.Addr{}, fmt.Errorf("invalid IP from local address")
	}
	return addr, nil
}

func detectNATBehavior(ctx context.Context, localIP, publicIP netip.Addr) (NATType, error) {
	for _, server := range stunServers {
		natType, err := testWithServer(ctx, server, localIP, publicIP)
		if err == nil && natType != NATBlocked {
			return natType, nil
		}
	}
	return NATBlocked, nil
}

func testWithServer(ctx context.Context, server string, localIP, publicIP netip.Addr) (NATType, error) {
	c, err := stun.Dial("udp4", server)
	if err != nil {
		return NATBlocked, err
	}
	defer c.Close()

	resp, err := doSTUNRequest(c)
	if err != nil {
		return NATBlocked, err
	}

	var mappedAddr stun.XORMappedAddress
	if err := mappedAddr.GetFrom(resp); err != nil {
		return NATBlocked, err
	}

	mappedIP, _ := netip.AddrFromSlice(mappedAddr.IP)

	if mappedIP != publicIP {
		return NATSymmetric, nil
	}

	return NATFullCone, nil
}

func doSTUNRequest(c *stun.Client) (*stun.Message, error) {
	msg, err := stun.Build(stun.TransactionID, stun.BindingRequest)
	if err != nil {
		return nil, err
	}

	res := make(chan *stun.Message, 1)
	if err := c.Do(msg, func(resEvent stun.Event) {
		if resEvent.Error != nil {
			return
		}
		res <- resEvent.Message
	}); err != nil {
		return nil, err
	}

	select {
	case m := <-res:
		return m, nil
	case <-time.After(5 * time.Second):
		return nil, fmt.Errorf("timeout")
	}
}
