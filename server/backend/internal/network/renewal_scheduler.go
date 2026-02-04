package network

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/jobqueue"
)

// RenewalScheduler periodically checks for expiring certificates and queues renewal jobs
type RenewalScheduler struct {
	queue            JobQueue
	caddyManager     *CaddyManager
	logger           *slog.Logger
	stopCh           chan struct{}
	wg               sync.WaitGroup
	interval         time.Duration
	renewalThreshold time.Duration // Renew certificates expiring within this time
	enabled          bool
}

// JobQueue interface for the scheduler
type JobQueue interface {
	Enqueue(jobType jobqueue.JobType, domain, email, routeID string, priority jobqueue.JobPriority) (jobqueue.JobInfo, error)
	GetLatestJob(ctx context.Context, domain string, jobType jobqueue.JobType) (jobqueue.JobInfo, error)
	IsRunning() bool
}

// RenewalSchedulerConfig configures the renewal scheduler
type RenewalSchedulerConfig struct {
	Enabled          bool
	Interval         time.Duration
	RenewalThreshold time.Duration // Default: 30 days
}

// DefaultRenewalSchedulerConfig returns sensible defaults
func DefaultRenewalSchedulerConfig() RenewalSchedulerConfig {
	return RenewalSchedulerConfig{
		Enabled:          true,
		Interval:         jobqueue.DefaultRenewalInterval,
		RenewalThreshold: time.Duration(jobqueue.DefaultRenewalThresholdDays) * 24 * time.Hour,
	}
}

// NewRenewalScheduler creates a new renewal scheduler
func NewRenewalScheduler(queue JobQueue, caddyManager *CaddyManager, cfg RenewalSchedulerConfig) *RenewalScheduler {
	if cfg.Interval <= 0 {
		cfg.Interval = jobqueue.DefaultRenewalInterval
	}
	if cfg.RenewalThreshold <= 0 {
		cfg.RenewalThreshold = time.Duration(jobqueue.DefaultRenewalThresholdDays) * 24 * time.Hour
	}

	return &RenewalScheduler{
		queue:            queue,
		caddyManager:     caddyManager,
		logger:           slog.Default().With("component", "renewal_scheduler"),
		stopCh:           make(chan struct{}),
		interval:         cfg.Interval,
		renewalThreshold: cfg.RenewalThreshold,
		enabled:          cfg.Enabled,
	}
}

// Start begins the renewal scheduler
func (rs *RenewalScheduler) Start() {
	if !rs.enabled {
		rs.logger.Info("renewal scheduler is disabled")
		return
	}

	rs.logger.Info("starting renewal scheduler",
		"interval", rs.interval,
		"threshold", rs.renewalThreshold)

	// Run immediately on start
	rs.wg.Add(1)
	go func() {
		defer rs.wg.Done()
		rs.checkAndRenew()
	}()

	// Then run on interval
	rs.wg.Add(1)
	go func() {
		defer rs.wg.Done()
		rs.runLoop()
	}()
}

// Stop halts the renewal scheduler
func (rs *RenewalScheduler) Stop() {
	if !rs.enabled {
		return
	}

	rs.logger.Info("stopping renewal scheduler")
	close(rs.stopCh)
	rs.wg.Wait()
	rs.logger.Info("renewal scheduler stopped")
}

// runLoop runs the scheduler on the configured interval
// runLoop runs the scheduler on the configured interval
// Note: The caller (Start) is responsible for calling wg.Done() via defer
func (rs *RenewalScheduler) runLoop() {
	ticker := time.NewTicker(rs.interval)
	defer ticker.Stop()

	for {
		select {
		case <-rs.stopCh:
			return
		case <-ticker.C:
			rs.checkAndRenew()
		}
	}
}

// checkAndRenew checks for expiring certificates and queues renewal jobs
func (rs *RenewalScheduler) checkAndRenew() {
	if rs.caddyManager == nil {
		rs.logger.Warn("caddy manager not available, skipping renewal check")
		return
	}

	if rs.queue == nil || !rs.queue.IsRunning() {
		rs.logger.Warn("job queue not running, skipping renewal check")
		return
	}

	ctx := context.Background()
	rs.logger.Info("checking for expiring certificates")

	// Get all routes with SSL enabled
	routes := rs.caddyManager.ListRoutes()
	if len(routes) == 0 {
		rs.logger.Debug("no routes configured, skipping renewal check")
		return
	}

	renewalCount := 0
	for _, route := range routes {
		if !route.SSL {
			continue
		}

		domain := route.FullDomain()

		// Check if certificate exists and get its expiry
		certInfo, err := rs.getCertificateInfo(ctx, domain)
		if err != nil {
			rs.logger.Warn("failed to get certificate info",
				"domain", domain,
				"error", err)
			continue
		}

		if certInfo == nil {
			rs.logger.Debug("no certificate found for domain",
				"domain", domain)
			continue
		}

		// Check if certificate is expiring soon
		if certInfo.DaysLeft <= int(rs.renewalThreshold.Hours()/24) {
			rs.logger.Info("certificate expiring soon, queuing renewal",
				"domain", domain,
				"days_left", certInfo.DaysLeft,
				"expires", certInfo.NotAfter)

			// Check if there's already a pending renewal job
			latestJob, err := rs.queue.GetLatestJob(ctx, domain, jobqueue.JobTypeRenewal)
			if err == nil && latestJob != nil && !latestJob.IsTerminal() {
				rs.logger.Debug("renewal job already pending/running",
					"domain", domain,
					"job_id", latestJob.GetID(),
					"status", latestJob.GetStatus())
				continue
			}

			// Get email from route or use default
			email := rs.caddyManager.Config().Email
			if email == "" {
				rs.logger.Warn("no email configured for renewal, using placeholder",
					"domain", domain)
				email = "admin@" + route.Domain
			}

			// Queue renewal job
			job, err := rs.queue.Enqueue(jobqueue.JobTypeRenewal, domain, email, route.ID, jobqueue.PriorityLow)
			if err != nil {
				rs.logger.Error("failed to enqueue renewal job",
					"domain", domain,
					"error", err)
				continue
			}

			renewalCount++
			rs.logger.Info("renewal job queued",
				"domain", domain,
				"job_id", job.GetID(),
				"days_left", certInfo.DaysLeft)
		}
	}

	if renewalCount > 0 {
		rs.logger.Info("renewal check complete",
			"renewals_queued", renewalCount,
			"total_routes_checked", len(routes))
	} else {
		rs.logger.Debug("renewal check complete - no certificates need renewal")
	}
}

// getCertificateInfo retrieves certificate information from Caddy
func (rs *RenewalScheduler) getCertificateInfo(ctx context.Context, domain string) (*CertificateInfo, error) {
	adminAPI := rs.caddyManager.Config().AdminAPI
	if adminAPI == "" {
		return nil, fmt.Errorf("caddy admin API not configured")
	}

	url := adminAPI + "/certificates"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("create request: %w", err)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("fetch certificates: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("caddy returned status %d", resp.StatusCode)
	}

	var certs []struct {
		Names    []string  `json:"names"`
		NotAfter time.Time `json:"not_after"`
		Issuer   string    `json:"issuer"`
	}

	if err := json.NewDecoder(resp.Body).Decode(&certs); err != nil {
		return nil, fmt.Errorf("decode certificates: %w", err)
	}

	// Find certificate for the domain
	for _, cert := range certs {
		for _, name := range cert.Names {
			if name == domain {
				now := time.Now()
				daysLeft := int(cert.NotAfter.Sub(now).Hours() / 24)
				if daysLeft < 0 {
					daysLeft = 0
				}

				return &CertificateInfo{
					Domain:    domain,
					Issuer:    cert.Issuer,
					NotBefore: now, // Caddy doesn't provide this in the simple endpoint
					NotAfter:  cert.NotAfter,
					DaysLeft:  daysLeft,
					AutoRenew: true,
				}, nil
			}
		}
	}

	return nil, nil // No certificate found
}

// GetStats returns scheduler statistics
func (rs *RenewalScheduler) GetStats() map[string]interface{} {
	return map[string]interface{}{
		"enabled":           rs.enabled,
		"interval":          rs.interval.String(),
		"renewal_threshold": rs.renewalThreshold.String(),
	}
}
