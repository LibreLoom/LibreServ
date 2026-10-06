//go:build !linux

package smtp

import "net"

// listenReusePort is a plain listen off Linux (development only).
func listenReusePort(addr string) (net.Listener, error) {
	return net.Listen("tcp", addr)
}
