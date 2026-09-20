package network

import (
	"context"
	"log/slog"
	"net/netip"
	"strings"
	"time"

	"github.com/huin/goupnp"
	"github.com/huin/goupnp/dcps/internetgateway2"
)

// UPnPMapping is one port mapping as returned by the router's IGD.
// The external port may differ from the requested one — always read it back.
type UPnPMapping struct {
	Protocol     string `json:"protocol"` // "tcp" | "udp"
	ExternalPort uint16 `json:"external_port"`
	InternalPort uint16 `json:"internal_port"`
	InternalIP   string `json:"internal_ip"`
	Description  string `json:"description,omitempty"`
	Enabled      bool   `json:"enabled"`
	LeaseSeconds uint32 `json:"lease_seconds"`
}

// UPnPStatus reports what UPnP discovery found on the LAN.
type UPnPStatus struct {
	Discovered  bool          `json:"discovered"`
	Enabled     bool          `json:"enabled"` // router answers and accepts mappings
	RouterMake  string        `json:"router_make,omitempty"`
	RouterModel string        `json:"router_model,omitempty"`
	WANIP       string        `json:"wan_ip,omitempty"` // router-reported WAN address (CGNAT detection)
	Mappings    []UPnPMapping `json:"mappings,omitempty"`
	Error       string        `json:"error,omitempty"`
}

// UPnPClient wraps goupnp internet-gateway discovery. Discovery is multicast
// and slow, so callers use Status()/AddMapping() and cache results with TTL.
type UPnPClient struct {
	logger *slog.Logger
}

func NewUPnPClient(logger *slog.Logger) *UPnPClient {
	return &UPnPClient{logger: logger}
}

// igdConnection is an IGD connection service plus its root device for metadata.
type igdConnection struct {
	client *internetgateway2.WANIPConnection2
	device *goupnp.RootDevice
}

// discover finds an IGD WANIPConnection2 service on the LAN.
func (u *UPnPClient) discover(ctx context.Context) (*igdConnection, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	clients, errors, err := internetgateway2.NewWANIPConnection2ClientsCtx(ctx)
	if err != nil {
		return nil, err
	}
	if len(clients) == 0 {
		if len(errors) > 0 {
			return nil, errors[0]
		}
		return nil, nil // no IGD found — UPnP not supported/enabled
	}
	// Prefer the first client that answers GetExternalIPAddress.
	for _, c := range clients {
		if _, err := c.GetExternalIPAddressCtx(ctx); err == nil {
			return &igdConnection{client: c, device: c.RootDevice}, nil
		}
	}
	return &igdConnection{client: clients[0], device: clients[0].RootDevice}, nil
}

// Status probes the LAN for UPnP IGD presence and capability. A nil return
// (no error, no data) means no IGD was discovered — UPnP off or unsupported.
func (u *UPnPClient) Status(ctx context.Context) (*UPnPStatus, error) {
	conn, err := u.discover(ctx)
	if err != nil {
		return &UPnPStatus{Discovered: false, Error: err.Error()}, nil
	}
	if conn == nil {
		return &UPnPStatus{Discovered: false}, nil
	}

	status := &UPnPStatus{Discovered: true, Enabled: true}
	if conn.device != nil {
		status.RouterMake = conn.device.Device.Manufacturer
		status.RouterModel = conn.device.Device.ModelName
	}

	wanIP, err := conn.client.GetExternalIPAddressCtx(ctx)
	if err == nil {
		status.WANIP = wanIP
	}

	// Enumerate existing mappings (best effort, up to 16).
	for i := uint16(0); i < 16; i++ {
		_, extPort, proto, intPort, intClient, enabled, desc, lease, err := conn.client.GetGenericPortMappingEntry(i)
		if err != nil {
			break
		}
		status.Mappings = append(status.Mappings, UPnPMapping{
			Protocol:     strings.ToLower(proto),
			ExternalPort: extPort,
			InternalPort: intPort,
			InternalIP:   intClient,
			Description:  desc,
			Enabled:      enabled,
			LeaseSeconds: lease,
		})
	}

	return status, nil
}

// AddMapping creates a port mapping for this device and returns the mapping
// as the router actually recorded it (external port may differ).
func (u *UPnPClient) AddMapping(ctx context.Context, protocol string, externalPort, internalPort uint16, description string) (*UPnPMapping, error) {
	conn, err := u.discover(ctx)
	if err != nil {
		return nil, err
	}
	if conn == nil {
		return nil, nil // no IGD
	}

	internalIP, ok := localIPv4()
	if !ok {
		return nil, nil
	}

	if err := conn.client.AddPortMappingCtx(ctx, "", externalPort, strings.ToUpper(protocol), internalPort, internalIP.String(), true, description, 0); err != nil {
		return nil, err
	}

	// Read back what the router actually recorded — IGD may assign a
	// different external port than requested (plan register #5).
	mapping := &UPnPMapping{
		Protocol:     strings.ToLower(protocol),
		ExternalPort: externalPort,
		InternalPort: internalPort,
		InternalIP:   internalIP.String(),
		Description:  description,
		Enabled:      true,
	}
	if intPort, intClient, enabled, _, lease, err := conn.client.GetSpecificPortMappingEntryCtx(ctx, "", externalPort, strings.ToUpper(protocol)); err == nil {
		if intPort != 0 {
			mapping.InternalPort = intPort
		}
		if intClient != "" {
			mapping.InternalIP = intClient
		}
		mapping.Enabled = enabled
		mapping.LeaseSeconds = lease
	}
	return mapping, nil
}

// DeleteMapping removes a port mapping.
func (u *UPnPClient) DeleteMapping(ctx context.Context, protocol string, externalPort uint16) error {
	conn, err := u.discover(ctx)
	if err != nil || conn == nil {
		return err
	}
	return conn.client.DeletePortMappingCtx(ctx, "", externalPort, strings.ToUpper(protocol))
}

// IsCGNAT reports whether the router's own WAN address indicates carrier-grade
// or double NAT. Requires UPnP discovery; returns false when unavailable.
func (u *UPnPClient) IsCGNAT(ctx context.Context, stunEgress netip.Addr) (bool, error) {
	status, err := u.Status(ctx)
	if err != nil || status == nil || status.WANIP == "" {
		return false, err
	}
	wanAddr, err := netip.ParseAddr(status.WANIP)
	if err != nil {
		return false, nil
	}
	return DetectCGNAT(wanAddr, stunEgress), nil
}
