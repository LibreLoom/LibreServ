package network

import (
	"context"
	"fmt"
	"log/slog"
	"net/netip"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/audit"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

type DDNSService struct {
	db           *database.DB
	providerMgr  *DNSProviderManager
	logger       *slog.Logger
	auditLogger  *audit.Service
	currentIP    netip.Addr
	interval     time.Duration
	mu           sync.RWMutex
	stop         chan struct{}
	stopped      chan struct{}
	running      bool
	ready        chan struct{}
	lastUpdate   time.Time
	lastError    error
	ipChangeHook func()
}

func NewDDNSService(db *database.DB, providerMgr *DNSProviderManager, auditLogger *audit.Service) *DDNSService {
	return &DDNSService{
		db:          db,
		providerMgr: providerMgr,
		logger:      slog.Default().With("component", "ddns"),
		auditLogger: auditLogger,
		interval:    5 * time.Minute,
		stop:        make(chan struct{}),
		stopped:     make(chan struct{}),
		ready:       make(chan struct{}),
	}
}

// OnIPChange registers a callback fired whenever the tracked public IP
// changes. The report loop uses it to regenerate without waiting for its
// own ticker.
func (s *DDNSService) OnIPChange(fn func()) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ipChangeHook = fn
}

func (s *DDNSService) SetInterval(d time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if d < time.Minute {
		d = time.Minute
	}
	if d > 60*time.Minute {
		d = 60 * time.Minute
	}
	s.interval = d
	s.logger.Debug("DDNS interval updated", "interval", d)
}

func (s *DDNSService) GetInterval() time.Duration {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.interval
}

func (s *DDNSService) Start() {
	s.mu.Lock()

	if s.running {
		s.mu.Unlock()
		return
	}

	s.stop = make(chan struct{})
	s.stopped = make(chan struct{})
	s.ready = make(chan struct{})
	s.running = true
	s.mu.Unlock()

	go s.run()
	<-s.ready
	s.logger.Info("DDNS auto-update service started")
}

func (s *DDNSService) Stop() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !s.running {
		return
	}

	close(s.stop)
	<-s.stopped
	s.running = false
	s.logger.Info("DDNS auto-update service stopped")
}

func (s *DDNSService) IsRunning() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.running
}

func (s *DDNSService) Status() (lastIP string, lastUpdate time.Time, lastError error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	if s.currentIP.IsValid() {
		lastIP = s.currentIP.String()
	}

	lastUpdate = s.lastUpdate
	lastError = s.lastError

	return
}

func (s *DDNSService) run() {
	defer close(s.stopped)

	s.mu.RLock()
	interval := s.interval
	s.mu.RUnlock()
	close(s.ready)

	for {
		ticker := time.NewTicker(interval)
		select {
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			s.UpdateDNS(ctx)
			cancel()
			s.mu.RLock()
			interval = s.interval
			s.mu.RUnlock()
		case <-s.stop:
			return
		}
	}
}

func (s *DDNSService) UpdateDNS(ctx context.Context) error {
	publicIP, err := DetectPublicIP(ctx)
	if err != nil {
		s.logger.Warn("Failed to detect public IP", "error", err)
		s.mu.Lock()
		s.lastError = err
		s.mu.Unlock()
		return err
	}

	s.mu.Lock()
	ipChanged := s.currentIP.IsValid() && s.currentIP != publicIP
	s.currentIP = publicIP
	hook := s.ipChangeHook
	s.mu.Unlock()

	if !ipChanged {
		s.logger.Debug("Public IP unchanged", "ip", publicIP)
		return nil
	}

	s.logger.Info("Public IP changed", "new_ip", publicIP)
	// Notify the report loop so it regenerates immediately rather than
	// serving a stale report until the next 15-min tick. Run it async:
	// regeneration (STUN+UPnP+probes, ~20s) must not delay the DNS write
	// that follows right after an IP change (review minor 3).
	if hook != nil {
		go hook()
	}

	cfg, err := s.providerMgr.GetConfig(ctx)
	if err != nil {
		s.logger.Warn("Failed to get DNS provider config", "error", err)
		s.mu.Lock()
		s.lastError = err
		s.mu.Unlock()
		return err
	}

	if cfg == nil || !cfg.Enabled {
		s.logger.Debug("DNS provider not configured, IP tracked but no DNS update")
		s.mu.Lock()
		s.lastUpdate = time.Now()
		s.mu.Unlock()
		return nil
	}

	if err := s.providerMgr.SetupWildcardDNS(ctx, cfg, publicIP); err != nil {
		s.logger.Warn("Failed to update DNS records", "error", err)
		s.mu.Lock()
		s.lastError = err
		s.lastUpdate = time.Now()
		s.mu.Unlock()

		if s.auditLogger != nil {
			s.auditLogger.Record(ctx, audit.Entry{
				ActorID:       "system",
				ActorUsername: "system",
				Action:        "network.ddns_update",
				Status:        "failure",
				Message:       fmt.Sprintf("DDNS update failed: %v", err),
				Metadata:      map[string]interface{}{"new_ip": publicIP.String()},
			})
		}

		return err
	}

	s.mu.Lock()
	s.lastUpdate = time.Now()
	s.lastError = nil
	s.mu.Unlock()

	s.logger.Info("DNS records updated", "ip", publicIP)

	if s.auditLogger != nil {
		s.auditLogger.Record(ctx, audit.Entry{
			ActorID:       "system",
			ActorUsername: "system",
			Action:        "network.ddns_update",
			Status:        "success",
			Message:       "DDNS records updated successfully",
			Metadata:      map[string]interface{}{"new_ip": publicIP.String()},
		})
	}

	return nil
}
