package jobs

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	cron "github.com/robfig/cron/v3"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/notify"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/storage"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/system"
)

// Scheduler manages periodic background jobs
type Scheduler struct {
	appManager     *apps.Manager
	sysChecker     *system.UpdateChecker
	notify         *notify.Service
	backupService  *storage.BackupService
	currentVersion string
	logger         *slog.Logger
	stopCh         chan struct{}
	wg             sync.WaitGroup
	mu             sync.Mutex
	runningBackups map[string]bool
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
		runningBackups: make(map[string]bool),
	}
}

// SetBackupService configures the backup service for scheduled backups
func (s *Scheduler) SetBackupService(bs *storage.BackupService) {
	s.backupService = bs
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

	// Job 3: Run due backup schedules every 60 seconds
	if s.backupService != nil {
		s.wg.Add(1)
		go s.runPeriodic("backup-schedules", 1*time.Minute, s.runBackupSchedules)
	}
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
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()

	s.appManager.TriggerRepoPull(ctx)

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
		if au.NeedsConfig {
			s.logger.Info("Skipping auto-update for needs_config app", "app", au.AppName, "instance_id", au.InstanceID)
			continue
		}
		s.logger.Info("Starting automated update for app", "app", au.AppName, "instance_id", au.InstanceID)
		if err := s.appManager.UpdateApp(ctx, au.InstanceID, false); err != nil {
			s.logger.Error("Automated update failed", "app", au.AppName, "error", err)
			subject := fmt.Sprintf("[LibreServ] Automated Update FAILED: %s", au.AppName)
			body := fmt.Sprintf("The automated update for %s failed.\n\nError: %v\n\nThe system has attempted to rollback to the previous version.", au.AppName, err)
			if nerr := s.notify.AdminNotify(ctx, subject, body); nerr != nil {
				// The admin never learns about the failed update otherwise.
				s.logger.Error("Failed to notify admin of failed automated update", "app", au.AppName, "error", nerr)
			}
		} else {
			s.logger.Info("Automated update successful", "app", au.AppName)
			subject := fmt.Sprintf("[LibreServ] Automated Update Successful: %s", au.AppName)
			body := fmt.Sprintf("LibreServ has successfully updated %s to version %s.", au.AppName, au.LatestVersion)
			if nerr := s.notify.AdminNotify(ctx, subject, body); nerr != nil {
				s.logger.Error("Failed to notify admin of successful automated update", "app", au.AppName, "error", nerr)
			}
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
		body := fmt.Sprintf("**A new version of LibreServ is available: %s**\n\nCurrent version: %s\n\n%s\n\n[Update Now](/settings/general)",
			info.LatestVersion, info.CurrentVersion, info.ReleaseNotes)
		if err := s.notify.AdminNotifyWithData(ctx, subject, body, map[string]interface{}{"markdown": true}); err != nil {
			s.logger.Error("Failed to send system update notification", "error", err)
		}
	} else {
		s.logger.Info("System is up to date", "version", s.currentVersion)
	}
}

func (s *Scheduler) runBackupSchedules() {
	if s.backupService == nil {
		return
	}

	listCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	schedules, err := s.backupService.ListSchedules(listCtx)
	if err != nil {
		s.logger.Error("Failed to list backup schedules", "error", err)
		return
	}

	now := time.Now()

	for _, schedule := range schedules {
		if !schedule.Enabled {
			continue
		}

		s.mu.Lock()
		if s.runningBackups[schedule.AppID] {
			s.mu.Unlock()
			s.logger.Debug("Skipping scheduled backup, app already has one running", "app_id", schedule.AppID)
			continue
		}
		s.mu.Unlock()

		if schedule.NextRun != nil && now.Before(*schedule.NextRun) {
			continue
		}

		parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
		parsed, pErr := parser.Parse(schedule.CronExpr)
		if pErr != nil {
			s.logger.Error("Invalid cron expression for backup schedule", "schedule_id", schedule.ID, "cron", schedule.CronExpr, "error", pErr)
			continue
		}

		s.mu.Lock()
		s.runningBackups[schedule.AppID] = true
		s.mu.Unlock()

		// Compute and persist NextRun BEFORE launching the goroutine so that
		// a restart mid-backup does not re-trigger the same schedule. The old
		// code only set NextRun after the backup completed, meaning a crash or
		// restart would see a stale (past-due) next_run and launch a duplicate.
		nextRun := parsed.Next(now)
		if err := s.backupService.UpdateScheduleNextRun(context.Background(), schedule.ID, now, nextRun); err != nil {
			s.logger.Error("Failed to update schedule next_run before backup", "schedule_id", schedule.ID, "error", err)
		}

		go func(sc storage.BackupSchedule, computedNextRun time.Time) {
			defer func() {
				s.mu.Lock()
				delete(s.runningBackups, sc.AppID)
				s.mu.Unlock()
			}()

			backupCtx, backupCancel := context.WithTimeout(context.Background(), 2*time.Hour)
			defer backupCancel()

			s.logger.Info("Running scheduled backup", "app_id", sc.AppID, "schedule_id", sc.ID)

			result, err := s.backupService.BackupApp(backupCtx, sc.AppID, sc.Options)
			if err != nil {
				s.logger.Error("Scheduled backup failed", "app_id", sc.AppID, "schedule_id", sc.ID, "error", err)
				subject := fmt.Sprintf("[LibreServ] Scheduled Backup FAILED: %s", sc.AppID)
				body := fmt.Sprintf("The scheduled backup for app %s failed.\n\nError: %v", sc.AppID, err)
				if nerr := s.notify.AdminNotify(backupCtx, subject, body); nerr != nil {
					s.logger.Error("Failed to notify admin of failed scheduled backup", "app_id", sc.AppID, "error", nerr)
				}

				// On failure, reschedule from the original next_run so the
				// schedule stays on its normal cadence (not from failure time).
				if nerr := s.backupService.UpdateScheduleNextRun(backupCtx, sc.ID, now, computedNextRun); nerr != nil {
					// Without a new next_run the schedule can re-fire in a tight
					// loop or stall entirely.
					s.logger.Error("Failed to reschedule backup after failure", "schedule_id", sc.ID, "error", nerr)
				}
			} else {
				s.logger.Info("Scheduled backup completed", "app_id", sc.AppID, "schedule_id", sc.ID, "duration", result.Duration)

				if sc.Retention > 0 {
					if err := s.backupService.CleanupOldBackups(backupCtx, sc.AppID, sc.Retention); err != nil {
						s.logger.Error("Failed to cleanup old backups", "app_id", sc.AppID, "error", err)
					}
				}
				// NextRun was already persisted before the goroutine started,
				// so no further update is needed on success.
			}
		}(schedule, nextRun)
	}
}
