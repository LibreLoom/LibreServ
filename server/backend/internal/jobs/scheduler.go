package jobs

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/notify"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/system"
)

// Scheduler manages periodic background jobs
type Scheduler struct {
	appManager     *apps.Manager
	sysChecker     *system.UpdateChecker
	notify         *notify.Service
	currentVersion string
	logger         *slog.Logger
	stopCh         chan struct{}
	wg             sync.WaitGroup
}

// NewScheduler creates a new scheduler
func NewScheduler(appManager *apps.Manager, sysChecker *system.UpdateChecker, notifySvc *notify.Service, currentVersion string) *Scheduler {
	return &Scheduler{
		appManager:     appManager,
		sysChecker:     sysChecker,
		notify:         notifySvc,
		currentVersion: currentVersion,
		logger:         slog.Default().With("component", "scheduler"),
		stopCh:         make(chan struct{}),
	}
}

// Start begins background job execution
func (s *Scheduler) Start() {
	s.logger.Info("Starting background scheduler")

	// Job 1: Check for app updates every 24 hours
	s.wg.Add(1)
	go s.runPeriodic("app-updates", 24*time.Hour, s.checkAppUpdates)

	// Job 2: Check for system updates every 24 hours
	s.wg.Add(1)
	go s.runPeriodic("system-updates", 24*time.Hour, s.checkSystemUpdates)
}

// Stop halts all background jobs
func (s *Scheduler) Stop() {
	s.logger.Info("Stopping background scheduler")
	close(s.stopCh)
	s.wg.Wait()
}

func (s *Scheduler) runPeriodic(name string, interval time.Duration, job func()) {
	defer s.wg.Done()
	
	// Initial run after short delay
	select {
	case <-time.After(1 * time.Minute):
		job()
	case <-s.stopCh:
		return
	}

	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ticker.C:
			s.logger.Info("Running scheduled job", "job", name)
			job()
		case <-s.stopCh:
			return
		}
	}
}

func (s *Scheduler) checkAppUpdates() {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute) // Longer timeout for potential updates
	defer cancel()

	updates, err := s.appManager.GetAvailableUpdates(ctx)
	if err != nil {
		s.logger.Error("Failed to check for app updates", "error", err)
		return
	}

	var updateList []string
	var autoUpdates []apps.AvailableUpdate

	for _, u := range updates {
		if !u.IsUpdate {
			continue
		}

		// Check if app has auto-update strategy
		installed, err := s.appManager.GetInstalledApp(ctx, u.InstanceID)
		if err != nil {
			continue
		}

		catalogApp, err := s.appManager.GetCatalog().GetApp(installed.AppID)
		if err == nil && catalogApp.Updates.Strategy == "auto" {
			autoUpdates = append(autoUpdates, u)
		} else {
			updateList = append(updateList, fmt.Sprintf("%s (%s -> %s)", u.AppName, u.CurrentVersion, u.LatestVersion))
		}
	}

	// 1. Process Auto-Updates
	for _, au := range autoUpdates {
		s.logger.Info("Starting automated update for app", "app", au.AppName, "instance_id", au.InstanceID)
		if err := s.appManager.UpdateApp(ctx, au.InstanceID); err != nil {
			s.logger.Error("Automated update failed", "app", au.AppName, "error", err)
			subject := fmt.Sprintf("[LibreServ] Automated Update FAILED: %s", au.AppName)
			body := fmt.Sprintf("The automated update for %s failed.\n\nError: %v\n\nThe system has attempted to rollback to the previous version.", au.AppName, err)
			_ = s.notify.AdminNotify(ctx, subject, body)
		} else {
			s.logger.Info("Automated update successful", "app", au.AppName)
			subject := fmt.Sprintf("[LibreServ] Automated Update Successful: %s", au.AppName)
			body := fmt.Sprintf("LibreServ has successfully updated %s to version %s.", au.AppName, au.LatestVersion)
			_ = s.notify.AdminNotify(ctx, subject, body)
		}
	}

	// 2. Notify about manual updates
	if len(updateList) > 0 {
		s.logger.Info("Update check complete: manual updates available", "count", len(updateList))
		subject := fmt.Sprintf("[LibreServ] %d App Updates Available", len(updateList))
		body := "The following apps have updates available (manual update required):\n\n" + strings.Join(updateList, "\n") + "\n\nUpdate them via the LibreServ dashboard."
		if err := s.notify.AdminNotify(ctx, subject, body); err != nil {
			s.logger.Error("Failed to send app update notification", "error", err)
		}
	} else if len(autoUpdates) == 0 {
		s.logger.Info("Update check complete: all apps up to date")
	}
}

func (s *Scheduler) checkSystemUpdates() {
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Minute)
	defer cancel()

	info, err := s.sysChecker.CheckForUpdates(s.currentVersion)
	if err != nil {
		s.logger.Error("Failed to check for system updates", "error", err)
		return
	}

	if info.UpdateAvailable {
		s.logger.Info("System update available!", "latest", info.LatestVersion, "url", info.URL)
		subject := "[LibreServ] Platform Update Available: " + info.LatestVersion
		body := fmt.Sprintf("A new version of LibreServ is available: %s\n\nCurrent version: %s\n\nRelease notes:\n%s\n\nDownload at: %s",
			info.LatestVersion, info.CurrentVersion, info.ReleaseNotes, info.URL)
		if err := s.notify.AdminNotify(ctx, subject, body); err != nil {
			s.logger.Error("Failed to send system update notification", "error", err)
		}
	} else {
		s.logger.Info("System is up to date", "version", s.currentVersion)
	}
}
