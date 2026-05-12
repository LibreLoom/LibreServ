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
		if ip4[0] == 169 && ip4[1] == 254 {
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
	blocked := []string{"metadata.google.internal", "metadata.azure.internal"}
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
