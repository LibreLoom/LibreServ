package monitoring

import (
	"context"
	"fmt"
	"net"
	"time"
)

// TCPCheck performs TCP connection health checks
type TCPCheck struct {
	Config  TCPCheckConfig
	Timeout time.Duration
}

// NewTCPCheck creates a TCP health check with a timeout.
func NewTCPCheck(cfg TCPCheckConfig, timeout time.Duration) *TCPCheck {
	return &TCPCheck{
		Config:  cfg,
		Timeout: timeout,
	}
}

// Type returns the check type.
func (t *TCPCheck) Type() string {
	return "tcp"
}

// Run executes the TCP check.
// Destinations are gated the same way as HTTP checks: loopback and public
// addresses are allowed; private, link-local, CGNAT, and metadata are blocked.
func (t *TCPCheck) Run(ctx context.Context) CheckResult {
	result := CheckResult{
		CheckType: t.Type(),
		Timestamp: time.Now(),
	}

	if err := validateTCPCheckHost(t.Config.Host); err != nil {
		result.Status = HealthStatusUnhealthy
		result.Message = fmt.Sprintf("Blocked health check host: %v", err)
		return result
	}

	address := net.JoinHostPort(t.Config.Host, fmt.Sprintf("%d", t.Config.Port))

	dialer := &net.Dialer{
		Timeout: t.Timeout,
	}

	conn, err := dialTCPCheck(ctx, dialer, t.Config.Host, t.Config.Port)
	if err != nil {
		result.Status = HealthStatusUnhealthy
		result.Message = fmt.Sprintf("TCP connection failed: %v", err)
		return result
	}
	_ = conn.Close()

	result.Status = HealthStatusHealthy
	result.Message = fmt.Sprintf("TCP check passed (%s)", address)
	return result
}
