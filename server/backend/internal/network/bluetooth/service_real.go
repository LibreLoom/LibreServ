//go:build libreserv_ble

package bluetooth

import "log/slog"

// Service wraps the real BLE GATT peripheral. It is only compiled when the
// libreserv_ble build tag is set.
type Service struct {
	ps *proxyServer
}

// NewService creates a real BLE proxy service using the given setup code.
func NewService(setupCode string, logger *slog.Logger) *Service {
	return &Service{ps: newProxyServer(setupCode, logger)}
}

// Start enables the BLE adapter, registers the LibreServ GATT service,
// and begins advertising.
func (s *Service) Start() error {
	if s.ps == nil {
		return nil
	}
	return s.ps.Start()
}

// Stop tears down the BLE advertisement and closes any active connections.
func (s *Service) Stop() {
	if s.ps == nil {
		return
	}
	s.ps.Stop()
}
