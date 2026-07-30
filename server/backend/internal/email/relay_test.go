package email

import "testing"

// TestRelayIsSelfForward covers the guard that stops the Relay from forwarding
// to its own listener — the bug that produced the runaway
// "550 could not send email: 550 could not send email: …" loop.
func TestRelayIsSelfForward(t *testing.T) {
	cases := []struct {
		name       string
		host       string
		port       int
		listenPort int
		want       bool
	}{
		{"localhost same port", "localhost", 2525, 2525, true},
		{"127.0.0.1 same port", "127.0.0.1", 25, 25, true},
		{"ipv6 loopback same port", "::1", 2525, 2525, true},
		{"loopback wrong port", "127.0.0.1", 587, 2525, false}, // provider on 587, not the relay
		{"remote host", "smtp.resend.com", 587, 2525, false},
		{"listenPort unset", "127.0.0.1", 2525, 0, false},
		{"different loopback port", "localhost", 25, 2525, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := &Relay{
				upstream:   upstreamConfig{host: c.host, port: c.port},
				listenPort: c.listenPort,
			}
			if got := r.isSelfForward(); got != c.want {
				t.Fatalf("isSelfForward() = %v, want %v", got, c.want)
			}
		})
	}
}
