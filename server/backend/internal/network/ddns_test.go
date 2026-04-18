package network

import (
	"context"
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/audit"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/database"
)

func TestDDNSService_StartStop(t *testing.T) {
	db := &database.DB{}
	providerMgr := NewDNSProviderManager(db)
	auditLogger := &audit.Service{}

	svc := NewDDNSService(db, providerMgr, auditLogger)

	if svc.IsRunning() {
		t.Fatal("service should not be running initially")
	}

	svc.Start()
	time.Sleep(100 * time.Millisecond)

	if !svc.IsRunning() {
		t.Fatal("service should be running after Start()")
	}

	svc.Stop()

	if svc.IsRunning() {
		t.Fatal("service should not be running after Stop()")
	}
}

func TestDDNSService_StartIdempotent(t *testing.T) {
	db := &database.DB{}
	providerMgr := NewDNSProviderManager(db)
	auditLogger := &audit.Service{}

	svc := NewDDNSService(db, providerMgr, auditLogger)

	svc.Start()
	defer svc.Stop()

	if !svc.IsRunning() {
		t.Fatal("service should be running")
	}

	svc.Start()

	if !svc.IsRunning() {
		t.Fatal("service should still be running after second Start()")
	}
}

func TestDDNSService_StopIdempotent(t *testing.T) {
	db := &database.DB{}
	providerMgr := NewDNSProviderManager(db)
	auditLogger := &audit.Service{}

	svc := NewDDNSService(db, providerMgr, auditLogger)

	svc.Stop()

	if svc.IsRunning() {
		t.Fatal("service should not be running")
	}
}

func TestDDNSService_Status(t *testing.T) {
	db := &database.DB{}
	providerMgr := NewDNSProviderManager(db)
	auditLogger := &audit.Service{}

	svc := NewDDNSService(db, providerMgr, auditLogger)

	lastIP, lastUpdate, lastError := svc.Status()

	if lastIP != "" {
		t.Error("lastIP should be empty initially")
	}

	if !lastUpdate.IsZero() {
		t.Error("lastUpdate should be zero initially")
	}

	if lastError != nil {
		t.Error("lastError should be nil initially")
	}
}

func TestDDNSService_DetectPublicIP_Network(t *testing.T) {
	ctx := context.Background()

	ip, err := DetectPublicIP(ctx)
	if err != nil {
		t.Skipf("skipping, no network access: %v", err)
	}

	if !ip.IsValid() {
		t.Error("expected valid IP address")
	}

	if !ip.Is4() && !ip.Is6() {
		t.Error("expected IPv4 or IPv6 address")
	}
}

func TestDDNSService_ConcurrentAccess(t *testing.T) {
	db := &database.DB{}
	providerMgr := NewDNSProviderManager(db)
	auditLogger := &audit.Service{}

	svc := NewDDNSService(db, providerMgr, auditLogger)
	svc.Start()
	defer svc.Stop()

	done := make(chan bool)

	go func() {
		for i := 0; i < 100; i++ {
			svc.IsRunning()
			svc.Status()
			time.Sleep(1 * time.Millisecond)
		}
		done <- true
	}()

	<-done
}
