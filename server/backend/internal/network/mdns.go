package network

import (
	"fmt"
	"log"
	"log/slog"
	"net"

	"github.com/hashicorp/mdns"
)

type MDNSService struct {
	server *mdns.Server
	host   string
	port   int
	logger *slog.Logger
}

func NewMDNSService(host string, port int) *MDNSService {
	return &MDNSService{
		host:   host,
		port:   port,
		logger: slog.Default().With("component", "mdns"),
	}
}

func (m *MDNSService) Start() error {
	ips, err := m.resolveIPs()
	if err != nil {
		return fmt.Errorf("resolve ips for mdns: %w", err)
	}
	if len(ips) == 0 {
		m.logger.Warn("no non-loopback IPs found, mDNS advertisement will not work")
		return nil
	}

	zone, err := mdns.NewMDNSService(
		"LibreServ",
		"_http._tcp",
		"local.",
		"",
		m.port,
		ips,
		[]string{"path=/setup"},
	)
	if err != nil {
		return fmt.Errorf("create mdns service: %w", err)
	}

	server, err := mdns.NewServer(&mdns.Config{
		Zone:              zone,
		LogEmptyResponses: false,
		Logger:            m.stdLog(),
	})
	if err != nil {
		return fmt.Errorf("start mdns server: %w", err)
	}

	m.server = server
	m.logger.Info("mDNS advertisement started",
		"hostname", "libreserv.local",
		"port", m.port,
		"ips", ips,
	)
	return nil
}

func (m *MDNSService) Stop() {
	if m.server != nil {
		_ = m.server.Shutdown()
		m.logger.Info("mDNS advertisement stopped")
	}
}

func (m *MDNSService) resolveIPs() ([]net.IP, error) {
	if m.host == "0.0.0.0" || m.host == "::" {
		return localIPs()
	}
	ip := net.ParseIP(m.host)
	if ip != nil && !ip.IsLoopback() {
		return []net.IP{ip}, nil
	}
	return localIPs()
}

func localIPs() ([]net.IP, error) {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil, err
	}
	var ips []net.IP
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 {
			continue
		}
		if iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			ipnet, ok := addr.(*net.IPNet)
			if !ok {
				continue
			}
			if ipnet.IP.To4() != nil {
				ips = append(ips, ipnet.IP)
			}
		}
	}
	return ips, nil
}

func (m *MDNSService) stdLog() *log.Logger {
	return slog.NewLogLogger(m.logger.Handler(), slog.LevelDebug)
}
