//go:build !libreserv_ble

package bluetooth

import "log/slog"

// Service is a no-op BLE backend when the libreserv_ble build tag is not set.
type Service struct{}

// NewService creates a stub BLE service that does nothing.
func NewService(setupCode string, logger *slog.Logger) *Service {
	return &Service{}
}

// Start is a no-op for the stub.
func (s *Service) Start() error { return nil }

// Stop is a no-op for the stub.
func (s *Service) Stop() {}
