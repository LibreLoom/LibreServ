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
	db          *database.DB
	providerMgr *DNSProviderManager
	logger      *slog.Logger
	auditLogger *audit.Service
	currentIP   netip.Addr
	mu          sync.RWMutex
	stop        chan struct{}
	stopped     chan struct{}
	running     bool
	lastUpdate  time.Time
	lastError   error
}

func NewDDNSService(db *database.DB, providerMgr *DNSProviderManager, auditLogger *audit.Service) *DDNSService {
	return &DDNSService{
		db:          db,
		providerMgr: providerMgr,
		logger:      slog.Default().With("component", "ddns"),
		auditLogger: auditLogger,
		stop:        make(chan struct{}),
		stopped:     make(chan struct{}),
	}
}

func (s *DDNSService) Start() {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.running {
		return
	}

	s.running = true
	go s.run()
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

	ticker := time.NewTicker(5 * time.Minute)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			s.updateDNS(ctx)
			cancel()
		case <-s.stop:
			return
		}
	}
}

func (s *DDNSService) updateDNS(ctx context.Context) error {
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
	s.mu.Unlock()

	if !ipChanged {
		s.logger.Debug("Public IP unchanged", "ip", publicIP)
		return nil
	}

	s.logger.Info("Public IP changed", "new_ip", publicIP)

	cfg, err := s.providerMgr.GetConfig(ctx)
	if err != nil {
		s.logger.Warn("Failed to get DNS provider config", "error", err)
		s.mu.Lock()
		s.lastError = err
		s.mu.Unlock()
		return err
	}

	if cfg == nil || !cfg.Enabled {
		s.logger.Debug("DNS provider not configured, skipping update")
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
