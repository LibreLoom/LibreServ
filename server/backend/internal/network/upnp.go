package network

import (
	"context"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/huin/goupnp/dcps/internetgateway2"
)

type UPnPConfig struct {
	Enabled bool `yaml:"enabled" json:"enabled"`
	Timeout int  `yaml:"timeout" json:"timeout"`
}

type UPnPPortMapping struct {
	ExternalPort int    `json:"external_port"`
	InternalPort int    `json:"internal_port"`
	InternalHost string `json:"internal_host"`
	Protocol     string `json:"protocol"`
	Description  string `json:"description"`
}

type UPnPStatus struct {
	Available   bool          `json:"available"`
	Enabled     bool          `json:"enabled"`
	IGDDevice   string        `json:"igd_device,omitempty"`
	ServiceType string        `json:"service_type,omitempty"`
	ExternalIP  string        `json:"external_ip,omitempty"`
	Mappings    []MappingInfo `json:"mappings,omitempty"`
	Error       string        `json:"error,omitempty"`
}

type MappingInfo struct {
	ExternalPort int    `json:"external_port"`
	InternalPort int    `json:"internal_port"`
	InternalHost string `json:"internal_host"`
	Protocol     string `json:"protocol"`
	Description  string `json:"description"`
}

type UPnPService struct {
	mu          sync.RWMutex
	config      UPnPConfig
	logger      *slog.Logger
	client      interface{}
	serviceType string
	externalIP  string
	localIP     string
	mappings    map[int]*UPnPPortMapping
	initialized bool
}

func NewUPnPService(config UPnPConfig, logger *slog.Logger) *UPnPService {
	return &UPnPService{
		config:   config,
		logger:   logger.With("component", "upnp"),
		mappings: make(map[int]*UPnPPortMapping),
	}
}

func (u *UPnPService) Init() error {
	u.mu.Lock()
	defer u.mu.Unlock()

	if !u.config.Enabled {
		u.logger.Info("UPnP is disabled")
		return nil
	}

	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(u.config.Timeout)*time.Second)
	defer cancel()

	u.logger.Info("Discovering UPnP IGD devices...")

	ipConn1, _, err := internetgateway2.NewWANIPConnection1Clients()
	if err == nil && len(ipConn1) > 0 {
		u.client = ipConn1[0]
		u.serviceType = "WANIPConnection:1"
		u.logger.Info("Found WANIPConnection:1 device")
	} else {
		ipConn2, _, err := internetgateway2.NewWANIPConnection2Clients()
		if err == nil && len(ipConn2) > 0 {
			u.client = ipConn2[0]
			u.serviceType = "WANIPConnection:2"
			u.logger.Info("Found WANIPConnection:2 device")
		} else {
			pppConn, _, err := internetgateway2.NewWANPPPConnection1Clients()
			if err == nil && len(pppConn) > 0 {
				u.client = pppConn[0]
				u.serviceType = "WANPPPConnection:1"
				u.logger.Info("Found WANPPPConnection:1 device")
			} else {
				u.logger.Warn("No UPnP IGD devices found", "error", err)
				return fmt.Errorf("no UPnP devices found")
			}
		}
	}

	ip, err := u.getExternalIP(ctx)
	if err != nil {
		u.logger.Warn("Could not get external IP", "error", err)
	} else {
		u.externalIP = ip
		u.logger.Info("Got external IP", "ip", ip)
	}

	localIP, err := u.getLocalIP()
	if err != nil {
		u.logger.Warn("Could not get local IP", "error", err)
		u.localIP = "127.0.0.1"
	} else {
		u.localIP = localIP
		u.logger.Info("Using local IP", "ip", localIP)
	}

	u.initialized = true
	u.logger.Info("UPnP service initialized")
	return nil
}

func (u *UPnPService) getExternalIP(ctx context.Context) (string, error) {
	switch client := u.client.(type) {
	case *internetgateway2.WANIPConnection1:
		return client.GetExternalIPAddress()
	case *internetgateway2.WANIPConnection2:
		return client.GetExternalIPAddress()
	case *internetgateway2.WANPPPConnection1:
		return client.GetExternalIPAddress()
	default:
		return "", fmt.Errorf("unknown client type")
	}
}

func (u *UPnPService) getLocalIP() (string, error) {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "", err
	}
	defer conn.Close()

	localAddr := conn.LocalAddr().(*net.UDPAddr)
	return localAddr.IP.String(), nil
}

func (u *UPnPService) AddPortMapping(mapping *UPnPPortMapping) error {
	u.mu.Lock()
	defer u.mu.Unlock()

	if !u.config.Enabled {
		return fmt.Errorf("UPnP is disabled")
	}

	if !u.initialized {
		if err := u.Init(); err != nil {
			return err
		}
	}

	host := mapping.InternalHost
	if host == "" {
		host = u.localIP
	}

	protocol := mapping.Protocol
	if protocol == "" {
		protocol = "TCP"
	}

	duration := uint32(0)
	u.logger.Info("Adding port mapping",
		"external_port", mapping.ExternalPort,
		"internal_port", mapping.InternalPort,
		"host", host,
		"protocol", protocol,
		"description", mapping.Description)

	switch client := u.client.(type) {
	case *internetgateway2.WANIPConnection1:
		err := client.AddPortMapping(
			"",
			uint16(mapping.ExternalPort),
			protocol,
			uint16(mapping.InternalPort),
			host,
			true,
			mapping.Description,
			duration,
		)
		if err != nil {
			return fmt.Errorf("failed to add mapping: %w", err)
		}
	case *internetgateway2.WANIPConnection2:
		err := client.AddPortMapping(
			"",
			uint16(mapping.ExternalPort),
			protocol,
			uint16(mapping.InternalPort),
			host,
			true,
			mapping.Description,
			duration,
		)
		if err != nil {
			return fmt.Errorf("failed to add mapping: %w", err)
		}
	case *internetgateway2.WANPPPConnection1:
		err := client.AddPortMapping(
			"",
			uint16(mapping.ExternalPort),
			protocol,
			uint16(mapping.InternalPort),
			host,
			true,
			mapping.Description,
			duration,
		)
		if err != nil {
			return fmt.Errorf("failed to add mapping: %w", err)
		}
	default:
		return fmt.Errorf("unknown client type")
	}

	u.mappings[mapping.ExternalPort] = mapping
	u.logger.Info("Port mapping added successfully")
	return nil
}

func (u *UPnPService) RemovePortMapping(externalPort int, protocol string) error {
	u.mu.Lock()
	defer u.mu.Unlock()

	if !u.config.Enabled {
		return fmt.Errorf("UPnP is disabled")
	}

	if !u.initialized {
		return fmt.Errorf("UPnP not initialized")
	}

	if protocol == "" {
		protocol = "TCP"
	}

	u.logger.Info("Removing port mapping", "port", externalPort, "protocol", protocol)

	switch client := u.client.(type) {
	case *internetgateway2.WANIPConnection1:
		err := client.DeletePortMapping("", uint16(externalPort), protocol)
		if err != nil {
			return fmt.Errorf("failed to remove mapping: %w", err)
		}
	case *internetgateway2.WANIPConnection2:
		err := client.DeletePortMapping("", uint16(externalPort), protocol)
		if err != nil {
			return fmt.Errorf("failed to remove mapping: %w", err)
		}
	case *internetgateway2.WANPPPConnection1:
		err := client.DeletePortMapping("", uint16(externalPort), protocol)
		if err != nil {
			return fmt.Errorf("failed to remove mapping: %w", err)
		}
	default:
		return fmt.Errorf("unknown client type")
	}

	delete(u.mappings, externalPort)
	u.logger.Info("Port mapping removed successfully")
	return nil
}

func (u *UPnPService) GetStatus() UPnPStatus {
	u.mu.RLock()
	defer u.mu.RUnlock()

	status := UPnPStatus{
		Enabled: u.config.Enabled,
	}

	if !u.config.Enabled {
		status.Error = "UPnP is disabled"
		return status
	}

	status.Available = u.initialized
	status.IGDDevice = u.serviceType
	status.ExternalIP = u.externalIP

	mappings := make([]MappingInfo, 0, len(u.mappings))
	for extPort, m := range u.mappings {
		mappings = append(mappings, MappingInfo{
			ExternalPort: extPort,
			InternalPort: m.InternalPort,
			InternalHost: m.InternalHost,
			Protocol:     m.Protocol,
			Description:  m.Description,
		})
	}
	status.Mappings = mappings

	return status
}

func (u *UPnPService) GetExternalIP() string {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.externalIP
}

func (u *UPnPService) IsAvailable() bool {
	u.mu.RLock()
	defer u.mu.RUnlock()
	return u.config.Enabled && u.initialized
}
