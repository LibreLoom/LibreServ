package network

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// ReportService periodically generates NetworkReports and caches the latest
// one. It is the single owner of report generation; it does NOT detect IP
// changes or write DNS — DDNSService owns that (5-min fast-path), and the
// report reads DDNSService's current IP, so the two never race on DNS.
type ReportService struct {
	upnp   *UPnPClient
	ddns   *DDNSService
	logger *slog.Logger
	inputs func() ReportInputs // resolves Connect/domain state at tick time

	interval time.Duration

	mu      sync.RWMutex
	report  *NetworkReport
	lastErr error

	stop    chan struct{}
	stopped chan struct{}
}

// NewReportService creates the report loop. inputs is called on each tick to
// refresh Connect/domain state; it may be nil.
func NewReportService(upnp *UPnPClient, ddns *DDNSService, inputs func() ReportInputs, logger *slog.Logger) *ReportService {
	return &ReportService{
		upnp:     upnp,
		ddns:     ddns,
		logger:   logger,
		inputs:   inputs,
		interval: 15 * time.Minute,
		stop:     make(chan struct{}),
		stopped:  make(chan struct{}),
	}
}

// Start begins the report loop and generates an initial report immediately.
func (s *ReportService) Start(ctx context.Context) {
	go func() {
		defer close(s.stopped)
		s.generate(ctx)
		ticker := time.NewTicker(s.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				s.generate(ctx)
			case <-s.stop:
				return
			}
		}
	}()
}

// Stop halts the loop.
func (s *ReportService) Stop() {
	select {
	case <-s.stop:
	default:
		close(s.stop)
	}
	<-s.stopped
}

func (s *ReportService) generate(ctx context.Context) {
	var inputs ReportInputs
	if s.inputs != nil {
		inputs = s.inputs()
	}
	report, err := GenerateNetworkReport(ctx, s.upnp, inputs, s.logger)
	if err == nil && report != nil {
		// Fold the DDNS-tracked public IP in as a fallback when STUN
		// detection failed (DDNS is the single IP-change detector).
		if report.Stacks.V4.PublicAddr == "" && s.ddns != nil {
			if ip, _, _ := s.ddns.Status(); ip != "" {
				report.Stacks.V4.PublicAddr = ip
				report.Stacks.V4.Available = true
			}
		}
	}
	s.mu.Lock()
	if err != nil {
		s.lastErr = err
		s.logger.Warn("Network report generation failed", "error", err)
	} else {
		s.report = report
		s.lastErr = nil
	}
	s.mu.Unlock()
}

// Report returns the latest cached report (may be nil before the first tick).
func (s *ReportService) Report() *NetworkReport {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.report
}

// SetReport replaces the cached report. Primarily for tests and for callers
// that inject externally-verified state into the loop.
func (s *ReportService) SetReport(r *NetworkReport) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.report = r
	s.lastErr = nil
}

// LastError returns the most recent generation error, if any.
func (s *ReportService) LastError() error {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.lastErr
}
