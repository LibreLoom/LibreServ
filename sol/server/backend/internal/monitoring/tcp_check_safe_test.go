package monitoring

import (
	"context"
	"net"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestValidateTCPCheckHost_BlocksPrivateAndMetadata(t *testing.T) {
	blocked := []string{
		"10.0.0.5",
		"192.168.1.1",
		"169.254.169.254",
		"::ffff:10.1.2.3",
		"::10.0.0.1",
		"::169.254.169.254",
		"metadata.google.internal",
		"100.100.100.200",
		"",
	}
	for _, host := range blocked {
		if err := validateTCPCheckHost(host); err == nil {
			t.Errorf("validateTCPCheckHost(%q) = nil, want error", host)
		}
	}

	allowed := []string{
		"127.0.0.1",
		"localhost",
		"::1",
		"8.8.8.8",
	}
	for _, host := range allowed {
		if err := validateTCPCheckHost(host); err != nil {
			t.Errorf("validateTCPCheckHost(%q) unexpected error: %v", host, err)
		}
	}
}

func TestTCPCheck_Run_BlocksPrivateHost(t *testing.T) {
	check := NewTCPCheck(TCPCheckConfig{Host: "10.0.0.1", Port: 80}, time.Second)
	res := check.Run(context.Background())
	if res.Status != HealthStatusUnhealthy {
		t.Fatalf("status = %q, want unhealthy", res.Status)
	}
	if !strings.Contains(res.Message, "Blocked health check host") {
		t.Errorf("message = %q, want blocked-host wording", res.Message)
	}
}

func TestTCPCheck_Run_BlocksMetadataHost(t *testing.T) {
	check := NewTCPCheck(TCPCheckConfig{Host: "169.254.169.254", Port: 80}, time.Second)
	res := check.Run(context.Background())
	if res.Status != HealthStatusUnhealthy {
		t.Fatalf("status = %q, want unhealthy", res.Status)
	}
	if !strings.Contains(strings.ToLower(res.Message), "blocked") {
		t.Errorf("message = %q, want blocked wording", res.Message)
	}
}

func TestTCPCheck_Run_AllowsLoopback(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	_, portStr, err := net.SplitHostPort(ln.Addr().String())
	if err != nil {
		t.Fatalf("split: %v", err)
	}
	port, err := strconv.Atoi(portStr)
	if err != nil {
		t.Fatalf("port: %v", err)
	}

	check := NewTCPCheck(TCPCheckConfig{Host: "127.0.0.1", Port: port}, time.Second)
	res := check.Run(context.Background())
	if res.Status != HealthStatusHealthy {
		t.Fatalf("status = %q, want healthy (%s)", res.Status, res.Message)
	}
}
