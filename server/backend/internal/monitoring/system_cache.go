package monitoring

import "time"

type CachedSystemResources struct {
	Timestamp         time.Time
	Resources         map[string]float64
	SystemMetrics     map[string]interface{}
	RunningContainers int
}
