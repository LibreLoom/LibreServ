package monitoring

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

// CaddyMetrics holds Prometheus metrics for Caddy operations
type CaddyMetrics struct {
	// Reload metrics
	ReloadAttempts *prometheus.CounterVec
	ReloadDuration *prometheus.HistogramVec
	ReloadRetries  *prometheus.HistogramVec

	// Certificate metrics
	CertIssuanceAttempts *prometheus.CounterVec
	CertIssuanceDuration *prometheus.HistogramVec
	CertRenewalAttempts  *prometheus.CounterVec
	CertExpiryTimestamp  *prometheus.GaugeVec

	// Admin API metrics
	AdminAPIRequests *prometheus.CounterVec
	AdminAPIDuration *prometheus.HistogramVec

	// Route operation metrics
	RouteOperations        *prometheus.CounterVec
	RouteOperationDuration *prometheus.HistogramVec
}

// NewCaddyMetrics creates and registers Caddy-related Prometheus metrics
func NewCaddyMetrics() *CaddyMetrics {
	return &CaddyMetrics{
		// Reload metrics
		ReloadAttempts: promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "caddy_reload_attempts_total",
				Help: "Total number of Caddy reload attempts",
			},
			[]string{"status"}, // status: success, failure
		),
		ReloadDuration: promauto.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "caddy_reload_duration_seconds",
				Help:    "Duration of Caddy reload operations",
				Buckets: prometheus.ExponentialBuckets(0.01, 2, 10), // 10ms to ~10s
			},
			[]string{"status"},
		),
		ReloadRetries: promauto.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "caddy_reload_retries",
				Help:    "Number of retry attempts for Caddy reloads",
				Buckets: []float64{0, 1, 2, 3, 4, 5, 10},
			},
			[]string{"status"},
		),

		// Certificate metrics
		CertIssuanceAttempts: promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "caddy_cert_issuance_attempts_total",
				Help: "Total number of certificate issuance attempts",
			},
			[]string{"status", "type"}, // status: success, failure; type: auto, external
		),
		CertIssuanceDuration: promauto.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "caddy_cert_issuance_duration_seconds",
				Help:    "Duration of certificate issuance operations",
				Buckets: prometheus.ExponentialBuckets(1, 2, 10), // 1s to ~17min
			},
			[]string{"status", "type"},
		),
		CertRenewalAttempts: promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "caddy_cert_renewal_attempts_total",
				Help: "Total number of certificate renewal attempts",
			},
			[]string{"status"},
		),
		CertExpiryTimestamp: promauto.NewGaugeVec(
			prometheus.GaugeOpts{
				Name: "caddy_cert_expiry_timestamp",
				Help: "Timestamp when certificate expires (Unix timestamp)",
			},
			[]string{"domain"},
		),

		// Admin API metrics
		AdminAPIRequests: promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "caddy_admin_api_requests_total",
				Help: "Total number of Admin API requests",
			},
			[]string{"method", "endpoint", "status"},
		),
		AdminAPIDuration: promauto.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "caddy_admin_api_duration_seconds",
				Help:    "Duration of Admin API requests",
				Buckets: prometheus.ExponentialBuckets(0.001, 2, 10), // 1ms to ~1s
			},
			[]string{"method", "endpoint"},
		),

		// Route operation metrics
		RouteOperations: promauto.NewCounterVec(
			prometheus.CounterOpts{
				Name: "caddy_route_operations_total",
				Help: "Total number of route operations",
			},
			[]string{"operation", "status"}, // operation: add, update, delete
		),
		RouteOperationDuration: promauto.NewHistogramVec(
			prometheus.HistogramOpts{
				Name:    "caddy_route_operation_duration_seconds",
				Help:    "Duration of route operations",
				Buckets: prometheus.ExponentialBuckets(0.01, 2, 10),
			},
			[]string{"operation"},
		),
	}
}

// RecordReload records metrics for a Caddy reload operation
func (m *CaddyMetrics) RecordReload(success bool, duration time.Duration, retries int) {
	status := "success"
	if !success {
		status = "failure"
	}
	m.ReloadAttempts.WithLabelValues(status).Inc()
	m.ReloadDuration.WithLabelValues(status).Observe(duration.Seconds())
	m.ReloadRetries.WithLabelValues(status).Observe(float64(retries))
}

// RecordCertIssuance records metrics for certificate issuance
func (m *CaddyMetrics) RecordCertIssuance(success bool, certType string, duration time.Duration) {
	status := "success"
	if !success {
		status = "failure"
	}
	m.CertIssuanceAttempts.WithLabelValues(status, certType).Inc()
	m.CertIssuanceDuration.WithLabelValues(status, certType).Observe(duration.Seconds())
}

// RecordCertRenewal records metrics for certificate renewal
func (m *CaddyMetrics) RecordCertRenewal(success bool) {
	status := "success"
	if !success {
		status = "failure"
	}
	m.CertRenewalAttempts.WithLabelValues(status).Inc()
}

// UpdateCertExpiry updates the certificate expiry timestamp
func (m *CaddyMetrics) UpdateCertExpiry(domain string, expiry time.Time) {
	m.CertExpiryTimestamp.WithLabelValues(domain).Set(float64(expiry.Unix()))
}

// RecordAdminAPIRequest records metrics for Admin API requests
func (m *CaddyMetrics) RecordAdminAPIRequest(method, endpoint string, success bool, duration time.Duration) {
	status := "success"
	if !success {
		status = "failure"
	}
	m.AdminAPIRequests.WithLabelValues(method, endpoint, status).Inc()
	m.AdminAPIDuration.WithLabelValues(method, endpoint).Observe(duration.Seconds())
}

// RecordRouteOperation records metrics for route operations
func (m *CaddyMetrics) RecordRouteOperation(operation string, success bool, duration time.Duration) {
	status := "success"
	if !success {
		status = "failure"
	}
	m.RouteOperations.WithLabelValues(operation, status).Inc()
	m.RouteOperationDuration.WithLabelValues(operation).Observe(duration.Seconds())
}
