package jobs

import (
	"testing"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/notify"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/system"
)

func TestScheduler_NewScheduler(t *testing.T) {
	appManager := &apps.Manager{}
	sysChecker := &system.UpdateChecker{}
	notifySvc := &notify.Service{}

	scheduler := NewScheduler(appManager, sysChecker, notifySvc, "v1.0.0")

	if scheduler == nil {
		t.Fatal("expected non-nil scheduler")
	}

	if scheduler.currentVersion != "v1.0.0" {
		t.Errorf("expected version v1.0.0, got %s", scheduler.currentVersion)
	}
}

func TestScheduler_StartStop(t *testing.T) {
	appManager := &apps.Manager{}
	sysChecker := &system.UpdateChecker{}
	notifySvc := &notify.Service{}

	scheduler := NewScheduler(appManager, sysChecker, notifySvc, "v1.0.0")

	scheduler.Start()
	time.Sleep(50 * time.Millisecond)

	scheduler.Stop()
}

func TestScheduler_StartIdempotent(t *testing.T) {
	appManager := &apps.Manager{}
	sysChecker := &system.UpdateChecker{}
	notifySvc := &notify.Service{}

	scheduler := NewScheduler(appManager, sysChecker, notifySvc, "v1.0.0")

	scheduler.Start()
	defer scheduler.Stop()

	scheduler.Start()
}
