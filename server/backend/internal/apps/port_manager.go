package apps

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net"
	"sync"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

const (
	// WellKnownPortMax is the highest well-known port (1-1023).
	// These are reserved for system services and should not be auto-allocated.
	WellKnownPortMax = 1023

	// MaxPort is the highest valid port number.
	MaxPort = 65535

	// MaxScanAttempts limits how many ports we try before giving up.
	MaxScanAttempts = 1000
)

// PortManager tracks allocated ports and provides automatic allocation.
// It derives used ports at startup from installed app metadata in the database.
type PortManager struct {
	mu         sync.RWMutex
	db         *database.DB
	catalog    *Catalog
	usedPorts  map[int]string // port → instanceID
	serverPort int            // LibreServ's own port (protected)
	logger     *slog.Logger
}

// NewPortManager creates a new PortManager.
func NewPortManager(db *database.DB, catalog *Catalog, serverPort int) *PortManager {
	return &PortManager{
		db:         db,
		catalog:    catalog,
		usedPorts:  make(map[int]string),
		serverPort: serverPort,
		logger:     slog.Default().With("component", "port-manager"),
	}
}

// Init scans all installed apps and populates the used-ports set.
// Call this once at startup.
func (pm *PortManager) Init() error {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	pm.usedPorts = make(map[int]string)

	rows, err := pm.db.Query(`SELECT id, source, metadata FROM apps`)
	if err != nil {
		return fmt.Errorf("failed to query installed apps for port init: %w", err)
	}
	defer rows.Close()

	for rows.Next() {
		var instanceID, appID, metadataJSON string
		if err := rows.Scan(&instanceID, &appID, &metadataJSON); err != nil {
			pm.logger.Warn("Failed to scan app row for port init", "error", err)
			continue
		}

		ports := pm.extractPorts(appID, metadataJSON)
		for _, port := range ports {
			pm.usedPorts[port] = instanceID
		}
	}

	pm.logger.Info("Port manager initialized", "allocated_ports", len(pm.usedPorts))
	return nil
}

// extractPorts reads port-type config values from an app's metadata JSON.
func (pm *PortManager) extractPorts(appID, metadataJSON string) []int {
	if metadataJSON == "" {
		return nil
	}

	var config map[string]interface{}
	if err := json.Unmarshal([]byte(metadataJSON), &config); err != nil {
		return nil
	}

	// Look up the app definition to find which config fields are port-type
	appDef, err := pm.catalog.GetApp(appID)
	if err != nil {
		// App no longer in catalog — also check deployment.ports as fallback
		return pm.extractPortsFromConfig(config)
	}

	var ports []int
	for _, field := range appDef.Configuration {
		if field.Type != "port" {
			continue
		}
		if v, ok := config[field.Name]; ok {
			if p := toInt(v); p > 0 {
				ports = append(ports, p)
			}
		}
	}

	// Also include deployment port mappings (these are the host ports in compose)
	for _, pm2 := range appDef.Deployment.Ports {
		if pm2.Host > 0 {
			ports = append(ports, pm2.Host)
		}
	}

	return ports
}

// extractPortsFromConfig is a fallback that checks for numeric values in port-like ranges.
func (pm *PortManager) extractPortsFromConfig(config map[string]interface{}) []int {
	var ports []int
	for _, v := range config {
		if p := toInt(v); p > WellKnownPortMax && p <= MaxPort {
			ports = append(ports, p)
		}
	}
	return ports
}

// GetUsedPorts returns a copy of the current port-to-instance mapping.
func (pm *PortManager) GetUsedPorts() map[int]string {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	result := make(map[int]string, len(pm.usedPorts))
	for k, v := range pm.usedPorts {
		result[k] = v
	}
	return result
}

// IsAvailable checks if a port can be used for allocation.
// It checks both the internal tracking and verifies the port is free at the OS level.
func (pm *PortManager) IsAvailable(port int) bool {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	if !pm.isAvailableLocked(port) {
		return false
	}

	return pm.isPortFreeAtOSLocked(port)
}

// IsPortFreeAtOS checks if a port is available at the OS level by attempting to bind to it.
func (pm *PortManager) IsPortFreeAtOS(port int) bool {
	pm.mu.RLock()
	defer pm.mu.RUnlock()

	return pm.isPortFreeAtOSLocked(port)
}

// isPortFreeAtOSLocked checks OS availability without acquiring the lock (caller must hold lock).
func (pm *PortManager) isPortFreeAtOSLocked(port int) bool {
	addr := fmt.Sprintf(":%d", port)
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		pm.logger.Debug("Port not available at OS level", "port", port, "error", err)
		return false
	}
	_ = listener.Close()
	return true
}

// isAvailableLocked checks availability without acquiring the lock (caller must hold lock).
func (pm *PortManager) isAvailableLocked(port int) bool {
	if port <= 0 || port > MaxPort {
		return false
	}
	if port <= WellKnownPortMax {
		return false
	}
	if port == pm.serverPort {
		return false
	}
	if _, used := pm.usedPorts[port]; used {
		return false
	}
	return true
}

// Allocate tries to assign the preferred port. If taken, scans upward to find
// the next available port. Returns the allocated port or an error if none found.
// It verifies port availability at both the internal tracking level and OS level.
func (pm *PortManager) Allocate(preferred int) (int, error) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	// Try preferred first (checks both DB and OS level via isAvailableLocked)
	if pm.isAvailableLocked(preferred) && pm.isPortFreeAtOSLocked(preferred) {
		return preferred, nil
	}

	// Scan upward from preferred+1, wrapping at MaxPort
	port := preferred + 1
	if port > MaxPort {
		port = WellKnownPortMax + 1
	}
	start := port

	for attempt := 0; attempt < MaxScanAttempts; attempt++ {
		if pm.isAvailableLocked(port) && pm.isPortFreeAtOSLocked(port) {
			return port, nil
		}
		port++
		if port > MaxPort {
			port = WellKnownPortMax + 1
		}
		if port == start {
			break // wrapped around completely
		}
	}

	return 0, fmt.Errorf("no available ports (exhausted scan from %d)", preferred)
}

// Reserve marks a port as used by a specific instance.
// Use this after allocation to record ownership.
func (pm *PortManager) Reserve(port int, instanceID string) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	pm.usedPorts[port] = instanceID
}

// Release removes a port from the used set.
func (pm *PortManager) Release(port int) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	delete(pm.usedPorts, port)
}

// ReleaseAll removes all ports associated with an instance.
func (pm *PortManager) ReleaseAll(instanceID string) {
	pm.mu.Lock()
	defer pm.mu.Unlock()

	for port, id := range pm.usedPorts {
		if id == instanceID {
			delete(pm.usedPorts, port)
		}
	}
}

// toInt converts various numeric types to int. Returns 0 on failure.
func toInt(v interface{}) int {
	switch val := v.(type) {
	case int:
		return val
	case int64:
		return int(val)
	case float64:
		return int(val)
	case float32:
		return int(val)
	case string:
		// best-effort
		var n int
		if _, err := fmt.Sscanf(val, "%d", &n); err == nil {
			return n
		}
	}
	return 0
}
