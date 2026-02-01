package network

import (
	"net"
	"strconv"
	"time"
)

// ProbeResult captures reachability test results.
type ProbeResult struct {
	Target    string        `json:"target"`
	Port      int           `json:"port"`
	Reachable bool          `json:"reachable"`
	Latency   time.Duration `json:"latency"`
	Error     string        `json:"error,omitempty"`
}

// ProbeTCP tries to connect to host:port with a timeout.
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
