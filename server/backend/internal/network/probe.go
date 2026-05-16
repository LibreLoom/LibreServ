package network

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

type ProbeResult struct {
	Target    string        `json:"target"`
	Port      int           `json:"port"`
	Reachable bool          `json:"reachable"`
	Latency   time.Duration `json:"latency"`
	Error     string        `json:"error,omitempty"`
}

func IsBlockedIP(ip net.IP) bool {
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() {
		return true
	}
	if ip4 := ip.To4(); ip4 != nil {
		// 169.254.0.0/16 — link-local (AWS/GCP/Azure metadata via IP)
		if ip4[0] == 169 && ip4[1] == 254 {
			return true
		}
		// 100.64.0.0/10 — Carrier-Grade NAT (includes Alibaba Cloud 100.100.100.200 metadata)
		if ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127 {
			return true
		}
	}
	return false
}

func ValidateHost(host string) error {
	if ip := net.ParseIP(host); ip != nil {
		if IsBlockedIP(ip) {
			return fmt.Errorf("target IP is not allowed")
		}
		return nil
	}
	blocked := []string{
		"metadata.google.internal",
		"metadata.azure.internal",
		"alibaba.zjgmeta.internal",       // Alibaba Cloud metadata
		"100.100.100.200",                // Alibaba Cloud metadata IP
		"fd00:ec2::254",                  // AWS IPv6 metadata (defense-in-depth, also blocked by IsBlockedIP)
	}
	lower := strings.ToLower(host)
	for _, b := range blocked {
		if lower == b {
			return fmt.Errorf("target host is not allowed")
		}
	}
	return nil
}

func ProbeTCP(host string, port int, timeout time.Duration) *ProbeResult {
	addr := net.JoinHostPort(host, strconv.Itoa(port))
	start := time.Now()
	conn, err := net.DialTimeout("tcp", addr, timeout)
	res := &ProbeResult{
		Target: host,
		Port:   port,
	}
	if err != nil {
		res.Reachable = false
		res.Error = err.Error()
		return res
	}
	res.Reachable = true
	res.Latency = time.Since(start)
	_ = conn.Close()
	return res
}
