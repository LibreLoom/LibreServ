package network

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

// Verifier is the "verify from outside" hook — Connect's verify-probe
// endpoint. The device cannot grade its own homework; only an external
// prober can set inbound_open. nil means no verification happens (the report
// marks inbound as unchecked).
type Verifier interface {
	// Verify asks the external prober to check host:port from outside.
	// Returns reachable=true when the port answers, false otherwise
	// (closed, filtered, or unreachable — all treated as not open).
	Verify(ctx context.Context, host string, port int, protocol string) (reachable bool, err error)
}

// ReportService periodically generates NetworkReports and caches the latest
// one. It runs the full plan §6 loop: diagnose → plan (via the engine, at the
// API layer) → act → VERIFY FROM OUTSIDE → record → re-report. It is the
// single owner of report generation; DDNSService owns DNS writes (the report
// reads its IP state, so the two never race).
type ReportService struct {
	upnp   *UPnPClient
	ddns   *DDNSService
	logger *slog.Logger
	inputs func() ReportInputs // resolves Connect/domain state at tick time

	// verifier probes host:port from outside (Connect verify-probe).
	verifier Verifier
	// state records per-app×path verify history (hysteresis). May be nil.
	state *PathStateStore

	interval time.Duration

	mu      sync.RWMutex
	report  *NetworkReport
	lastErr error

	stop    chan struct{}
	stopped chan struct{}
}

// NewReportService creates the report loop. inputs is called on each tick to
// refresh Connect/domain state; it may be nil. verifier/state enable the
// closed loop (verify-from-outside + hysteresis persistence); either may be
// nil to run in diagnose-only mode.
func NewReportService(upnp *UPnPClient, ddns *DDNSService, inputs func() ReportInputs, logger *slog.Logger, verifier Verifier, state *PathStateStore) *ReportService {
	return &ReportService{
		upnp:     upnp,
		ddns:     ddns,
		logger:   logger,
		inputs:   inputs,
		verifier: verifier,
		state:    state,
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

// generate runs one full loop iteration: probe the network, verify v4/v6 from
// outside when a verifier is available, record the results, and cache the
// report.
func (s *ReportService) generate(ctx context.Context) {
	var inputs ReportInputs
	if s.inputs != nil {
		inputs = s.inputs()
	}

	// Wire the verifier into the report: the ONLY path that sets
	// inbound_open. Verify the device's public v4 address on 443 (the
	// direct-web signal) and the v6 GUA on 443. Ports beyond 443 are the
	// engine's job (per-app VerifyHints); this is the base reachability check.
	if s.verifier != nil {
		// Direct-web signal: 80 OR 443 open counts as reachable. Many ISPs
		// block inbound 80 but allow 443 (register #20), so verifying only
		// 443 would wrongly mark a working direct setup as closed.
		inputs.VerifyV4 = func(ctx context.Context, addr string) (bool, error) {
			ok443, _ := s.verifier.Verify(ctx, addr, 443, "tcp")
			ok80, _ := s.verifier.Verify(ctx, addr, 80, "tcp")
			s.record(ctx, "direct_v4", ok443 || ok80, nil)
			return ok443 || ok80, nil
		}
		inputs.VerifyV6 = func(ctx context.Context, addr string) (bool, error) {
			ok443, _ := s.verifier.Verify(ctx, addr, 443, "tcp")
			ok80, _ := s.verifier.Verify(ctx, addr, 80, "tcp")
			s.record(ctx, "direct_v6", ok443 || ok80, nil)
			return ok443 || ok80, nil
		}
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

// record persists a verify outcome into path_state for hysteresis. app_id is
// the synthetic "system" cell (the engine's per-app cells are recorded by the
// engine/actuator layer).
func (s *ReportService) record(ctx context.Context, path string, ok bool, err error) {
	if s.state == nil {
		return
	}
	if ok {
		_ = s.state.RecordSuccess(ctx, "system", Path(path), "", 443)
		return
	}
	reason := "unreachable"
	if err != nil {
		reason = err.Error()
	}
	_ = s.state.RecordFailure(ctx, "system", Path(path), "", 443, reason)
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

// Regenerate runs one loop iteration on demand (e.g. when DDNS detects an
// IP change). Safe to call concurrently with the ticker.
func (s *ReportService) Regenerate(ctx context.Context) {
	s.generate(ctx)
}
