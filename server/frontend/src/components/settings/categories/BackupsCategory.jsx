import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { cn } from "@/lib/utils";
import { useAuth } from "../../../hooks/useAuth";
import { useToast } from "../../../context/ToastContext";
import {
  ShieldCheck,
  ShieldAlert,
  CloudOff,
  Cloud,
  Plus,
  ChevronDown,
  RotateCcw,
  Trash2,
  Download,
  Upload,
  Loader2,
  HelpCircle,
  Clock,
  CalendarClock,
  Calendar,
  HardDriveDownload,
  ArrowRight,
} from "lucide-react";
import AppIcon from "../../common/AppIcon";
import Callout from "../../common/Callout";
import CollapsibleSection from "../../common/CollapsibleSection";
import ConfirmModal from "../../cards/ConfirmModal";
import ModalCard from "../../cards/ModalCard";
import Pill from "../../common/Pill";
import SegmentedControl from "../../common/SegmentedControl";
import Button from "../../ui/Button";
import SettingsCard from "../SettingsCard.jsx";
import SettingsRow from "../SettingsRow.jsx";
import ScheduleForm from "../../backups/ScheduleForm";
import { formatBytes, formatRelativeTime } from "../../../lib/backups-utils";

const DEFAULT_SCHEDULE_CRON = "0 3 * * *";
const DEFAULT_RETENTION = 7;

function backupAgeState(lastBackupAt) {
  if (!lastBackupAt) return "none";
  const ageMs = Date.now() - new Date(lastBackupAt).getTime();
  if (ageMs < 2 * 24 * 60 * 60 * 1000) return "fresh";
  if (ageMs < 7 * 24 * 60 * 60 * 1000) return "aging";
  return "stale";
}

export default function BackupsCategory() {
  const { request } = useAuth();
  const { addToast } = useToast();

  const [backups, setBackups] = useState([]);
  const [apps, setApps] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [backingUpAppId, setBackingUpAppId] = useState(null);
  const [enablingAppId, setEnablingAppId] = useState(null);
  const [expandedAppId, setExpandedAppId] = useState(null);
  const [scheduleModalApp, setScheduleModalApp] = useState(null);

  const [restoreTarget, setRestoreTarget] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const [savingDb, setSavingDb] = useState(false);
  const [uploadingDb, setUploadingDb] = useState(false);
  const [pendingDbFile, setPendingDbFile] = useState(null);
  const dbFileInputRef = useRef(null);

  const showSuccess = useCallback((message, description) => {
    addToast({ type: "success", message, description });
  }, [addToast]);

  const showError = useCallback((message, description) => {
    addToast({ type: "error", message, description });
  }, [addToast]);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [backupsRes, appsRes, schedulesRes] = await Promise.all([
        request("/backups"),
        request("/apps"),
        request("/backups/schedules"),
      ]);

      if (!backupsRes.ok) {
        const err = await backupsRes.json();
        throw new Error(err.error || "Failed to load backups");
      }
      if (!appsRes.ok) {
        const err = await appsRes.json();
        throw new Error(err.error || "Failed to load apps");
      }
      if (!schedulesRes.ok) {
        const err = await schedulesRes.json();
        throw new Error(err.error || "Failed to load schedules");
      }

      const backupsData = await backupsRes.json();
      const appsData = await appsRes.json();
      const schedulesData = await schedulesRes.json();
      setBackups(backupsData.backups || []);
      setApps(appsData.apps || []);
      setSchedules(schedulesData.schedules || []);
    } catch (err) {
      console.error("Failed to load data:", err);
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const latestBackupByApp = useMemo(() => {
    const map = new Map();
    for (const backup of backups) {
      const existing = map.get(backup.app_id);
      if (!existing || new Date(backup.created_at) > new Date(existing.created_at)) {
        map.set(backup.app_id, backup);
      }
    }
    return map;
  }, [backups]);

  const backupsByApp = useMemo(() => {
    const map = new Map();
    for (const backup of backups) {
      const list = map.get(backup.app_id) || [];
      list.push(backup);
      map.set(backup.app_id, list);
    }
    return map;
  }, [backups]);

  const scheduleByApp = useMemo(() => {
    const map = new Map();
    for (const schedule of schedules) {
      map.set(schedule.app_id, schedule);
    }
    return map;
  }, [schedules]);

  const stats = useMemo(() => {
    const latestByApp = [...latestBackupByApp.values()];
    const protectedApps = latestByApp.length;
    const totalApps = apps.length;
    const lastBackupAt = latestByApp.length
      ? latestByApp.reduce((a, b) => (new Date(a.created_at) > new Date(b.created_at) ? a : b)).created_at
      : null;
    const totalSize = backups.reduce((sum, b) => sum + (b.size || 0), 0);
    const activeSchedules = schedules.filter((s) => s.enabled);
    const nextRunAt = activeSchedules
      .map((s) => s.next_run)
      .filter(Boolean)
      .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0] || null;
    const staleApps = latestByApp.filter((b) => backupAgeState(b.created_at) === "stale").length;
    return { protectedApps, totalApps, lastBackupAt, totalSize, nextRunAt, staleApps, scheduleCount: activeSchedules.length };
  }, [latestBackupByApp, backups, apps, schedules]);

  const guidance = useMemo(() => {
    /** @type {"success"|"warning"|"error"|"info"|"neutral"} */
    let tone;
    if (stats.totalApps === 0) return null;
    if (stats.protectedApps === 0) {
      tone = "warning";
      return {
        tone,
        icon: ShieldAlert,
        text: "Nothing is backed up yet. Tap \"Back up\" next to an app below — it takes seconds and you can undo mistakes later.",
      };
    }
    if (stats.scheduleCount === 0) {
      tone = "info";
      return {
        tone,
        icon: CalendarClock,
        text: "Backups run only when you tap the button. Turn on automatic backups for an app below and LibreServ will protect it every night.",
      };
    }
    if (stats.staleApps > 0) {
      tone = "warning";
      return {
        tone,
        icon: ShieldAlert,
        text: `${stats.staleApps === 1 ? "One app's" : `${stats.staleApps} apps'`} newest backup is over a week old. Consider backing it up again soon.`,
      };
    }
    tone = "neutral";
    return {
      tone,
      icon: Cloud,
      text: "For real peace of mind, keep a copy somewhere else too — backups on this device won't survive a fire or theft. Add off-site storage below.",
    };
  }, [stats]);

  async function handleBackupApp(appId) {
    setBackingUpAppId(appId);
    try {
      const res = await request("/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ app_id: appId, stop_before_backup: false }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to create backup");
      }
      showSuccess("Backup complete", "Your app's data is safely saved. You can restore it anytime.");
      loadData();
    } catch (err) {
      showError("Backup failed", err.message);
    } finally {
      setBackingUpAppId(null);
    }
  }

  async function handleEnableAutomatic(appId) {
    setEnablingAppId(appId);
    try {
      const res = await request("/backups/schedules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          app_id: appId,
          cron_expr: DEFAULT_SCHEDULE_CRON,
          enabled: true,
          stop_before_backup: false,
          retention: DEFAULT_RETENTION,
        }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to enable automatic backups");
      }
      showSuccess("Automatic backups on", "We'll back this app up every night at 3 AM and keep the 7 most recent copies.");
      loadData();
    } catch (err) {
      showError("Couldn't turn on automatic backups", err.message);
    } finally {
      setEnablingAppId(null);
    }
  }

  async function handleRestoreBackup() {
    if (!restoreTarget) return;
    setRestoring(true);
    try {
      const res = await request(`/backups/${restoreTarget.id}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stop_before_restore: true, restart_after_restore: true, verify_checksum: true }),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to restore backup");
      }
      setRestoreTarget(null);
      showSuccess("Backup restored", "Your data has been put back the way it was.");
      loadData();
    } catch (err) {
      showError("Restore failed", err.message);
    } finally {
      setRestoring(false);
    }
  }

  async function handleDeleteBackup() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      const res = await request(`/backups/${deleteTarget.id}`, { method: "DELETE" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to delete backup");
      }
      setDeleteTarget(null);
      showSuccess("Backup deleted", "That copy has been removed.");
      loadData();
    } catch (err) {
      showError("Couldn't delete backup", err.message);
    } finally {
      setDeleting(false);
    }
  }

  async function handleSaveDatabase() {
    setSavingDb(true);
    try {
      const res = await request("/backups/database", { method: "POST" });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to save system backup");
      }
      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `libreserv-system-${new Date().toISOString().slice(0, 10)}.db.gz`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      a.remove();
      showSuccess("System backup downloaded", "Keep this file somewhere safe — it contains all your LibreServ settings and accounts.");
    } catch (err) {
      showError("Couldn't save system backup", err.message);
    } finally {
      setSavingDb(false);
    }
  }

  function handleDbFileSelect(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const ext = file.name.toLowerCase();
    if (!ext.endsWith(".gz") && !ext.endsWith(".db")) {
      showError("That file won't work", "Please choose the system backup file you downloaded earlier (it ends in .gz or .db).");
      return;
    }
    setPendingDbFile(file);
  }

  async function handleConfirmDbRestore() {
    if (!pendingDbFile) return;
    await uploadAndRestoreDatabase(pendingDbFile);
    setPendingDbFile(null);
  }

  async function uploadAndRestoreDatabase(file) {
    setUploadingDb(true);
    try {
      const formData = new FormData();
      formData.append("backup", file);
      const res = await request("/backups/database/upload-restore", {
        method: "POST",
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to restore system backup");
      }
      showSuccess("System restored", "Everything has been put back. The page will reload now.");
      setTimeout(() => window.location.reload(), 2000);
    } catch (err) {
      showError("Couldn't restore system backup", err.message);
    } finally {
      setUploadingDb(false);
      if (dbFileInputRef.current) dbFileInputRef.current.value = "";
    }
  }

  function getAppName(appId) {
    return apps.find((a) => a.id === appId)?.name || appId || "Unknown app";
  }

  const heroTone = stats.protectedApps === 0 ? "warning" : stats.staleApps > 0 ? "warning" : "success";

  return (
    <div className="space-y-4" data-slot="backups-category">
      <SettingsCard icon={ShieldCheck} title="Your data's safety net" padding={false} index={0}>
        {loading ? (
          <div className="px-4 py-8 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-accent" />
          </div>
        ) : loadError ? (
          <div className="p-4">
            <Callout
              tone="error"
              title="We couldn't load your backup info"
              action={<Button variant="outline" size="sm" onClick={loadData}>Try again</Button>}
            >
                Something went wrong while checking your backups. This is usually temporary.
            </Callout>
          </div>
        ) : stats.totalApps === 0 ? (
          <div className="px-4 py-6 text-center">
            <Cloud size={32} className="text-accent mx-auto mb-2" aria-hidden="true" />
            <p className="text-sm text-primary mb-1">No apps installed yet</p>
            <p className="text-xs text-accent max-w-sm mx-auto">
              Once you install apps, this page becomes your safety net — one tap saves a copy of everything an app knows, so mistakes are never permanent.
            </p>
          </div>
        ) : (
          <>
            <div className="px-4 pt-4">
              <div
                className={cn(
                  "flex items-center gap-3 rounded-large-element border p-3",
                  heroTone === "success" && "bg-success/20 border-success/30",
                  heroTone === "warning" && "bg-warning/20 border-warning/30",
                )}
              >
                {heroTone === "success" ? (
                  <ShieldCheck size={22} className="text-success shrink-0" aria-hidden="true" />
                ) : (
                  <ShieldAlert size={22} className="text-warning shrink-0" aria-hidden="true" />
                )}
                <p className="text-sm text-primary">
                  {stats.protectedApps === 0
                    ? "None of your apps are backed up"
                    : stats.protectedApps === stats.totalApps
                      ? `All ${stats.totalApps} app${stats.totalApps !== 1 ? "s" : ""} backed up`
                      : `${stats.protectedApps} of ${stats.totalApps} apps backed up`}
                  {stats.lastBackupAt && (
                    <span className="text-accent"> · {formatRelativeTime(stats.lastBackupAt)}</span>
                  )}
                </p>
              </div>
            </div>

            <SettingsRow label="Last backup" description="The most recent copy of any app's data">
              <Pill variant={stats.lastBackupAt ? (backupAgeState(stats.lastBackupAt) === "stale" ? "warning" : "success") : "muted"}>
                {stats.lastBackupAt ? formatRelativeTime(stats.lastBackupAt) : "Never"}
              </Pill>
            </SettingsRow>

            <SettingsRow label="Next automatic backup" description="When scheduled backups will run next">
              <Pill variant={stats.nextRunAt ? "default" : "muted"}>
                {stats.nextRunAt ? formatRelativeTime(stats.nextRunAt) : "Not scheduled"}
              </Pill>
            </SettingsRow>

            <SettingsRow label="Space used by backups" description="Total size of all saved copies on this device" hideDivider>
              <Pill variant="muted">
                <HardDriveDownload size={12} aria-hidden="true" />
                {stats.totalSize > 0 ? formatBytes(stats.totalSize) : "—"}
              </Pill>
            </SettingsRow>

            {guidance && (
              <div className="px-4 pb-4">
                <Callout tone={guidance.tone} icon={guidance.icon} rounded="card">
                  {guidance.text}
                </Callout>
              </div>
            )}
          </>
        )}
      </SettingsCard>

      {!loading && !loadError && stats.totalApps > 0 && (
        <SettingsCard icon={Cloud} title="Your apps" padding={false} index={1}>
          <div className="px-4 pt-3 pb-1">
            <p className="text-xs text-accent">
              Tap an app to see its saved copies and restore one. Backups happen while the app keeps running.
            </p>
          </div>
          <div className="divide-y divide-primary/10">
            {apps.map((app) => {
              const latest = latestBackupByApp.get(app.id);
              const appBackups = backupsByApp.get(app.id) || [];
              const schedule = scheduleByApp.get(app.id);
              const age = backupAgeState(latest?.created_at);
              const expanded = expandedAppId === app.id;
              const busy = backingUpAppId === app.id;

              return (
                <div key={app.id}>
                  <div className="px-4 py-3 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={() => setExpandedAppId(expanded ? null : app.id)}
                      className="flex items-center gap-3 flex-1 min-w-0 text-left rounded-card no-focus-outline focus-visible:ring-2 focus-visible:ring-accent"
                      aria-expanded={expanded}
                      aria-label={`${app.name} backups`}
                    >
                      <AppIcon appId={app.app_id} size={32} />
                      <span className="flex-1 min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="font-mono text-sm text-primary truncate">{app.name}</span>
                          {latest ? (
                            <Pill variant={age === "stale" ? "warning" : "success"} className="shrink-0">
                              {age === "stale" ? `${appBackups.length} ${appBackups.length === 1 ? "copy" : "copies"} · old` : `${appBackups.length} ${appBackups.length === 1 ? "copy" : "copies"}`}
                            </Pill>
                          ) : (
                            <Pill variant="muted" className="shrink-0">
                              <CloudOff size={12} aria-hidden="true" />
                              No backups
                            </Pill>
                          )}
                        </span>
                        <span className="block text-xs text-accent mt-0.5">
                          {latest ? `Last saved ${formatRelativeTime(latest.created_at)}` : "Nothing saved yet"}
                          {schedule?.enabled ? " · Automatic" : ""}
                        </span>
                      </span>
                      <ChevronDown
                        size={16}
                        className={cn("text-accent shrink-0 motion-safe:transition-transform", expanded && "rotate-180")}
                        aria-hidden="true"
                      />
                    </button>
                    <Button
                      variant={latest ? "outline" : "primary"}
                      size="sm"
                      onClick={() => handleBackupApp(app.id)}
                      loading={busy}
                      className="shrink-0"
                    >
                      {!busy && <Plus size={14} aria-hidden="true" />}
                      {busy ? "Backing up…" : "Back up"}
                    </Button>
                  </div>

                  {expanded && (
                    <div className="px-4 pb-4 animate-in fade-in slide-in-from-top-1" style={{ animationDuration: "var(--motion-duration-short4)" }}>
                      <div className="rounded-card bg-primary/5 border border-primary/10 p-3 space-y-3">
                        {schedule?.enabled ? (
                          <div className="flex items-center justify-between gap-3">
                            <div className="flex items-center gap-2 min-w-0">
                              <CalendarClock size={14} className="text-accent shrink-0" aria-hidden="true" />
                              <p className="text-xs text-primary truncate">
                                Automatic backups on
                                {schedule.next_run ? ` · next ${formatRelativeTime(schedule.next_run)}` : ""}
                                {` · keeps ${schedule.retention}`}
                              </p>
                            </div>
                            <Button variant="ghost" size="sm" onClick={() => setScheduleModalApp(app)}>
                              Change
                            </Button>
                          </div>
                        ) : (
                          <div className="flex flex-col sm:flex-row sm:items-center gap-3 sm:justify-between">
                            <div className="flex items-center gap-2 min-w-0">
                              <CalendarClock size={14} className="text-accent shrink-0" aria-hidden="true" />
                              <p className="text-xs text-primary">Automatic backups are off for this app</p>
                            </div>
                            <SegmentedControl
                              value="off"
                              onChange={(val) => {
                                if (val === "on") handleEnableAutomatic(app.id);
                              }}
                              options={[
                                { value: "off", label: "Off" },
                                { value: "on", label: enablingAppId === app.id ? "Turning on…" : "Nightly" },
                              ]}
                            />
                          </div>
                        )}

                        {appBackups.length === 0 ? (
                          <p className="text-xs text-accent">
                            No copies yet. Use the Back up button above to make the first one.
                          </p>
                        ) : (
                          <ul className="space-y-2">
                            {appBackups.map((backup) => (
                              <li key={backup.id} className="flex items-center justify-between gap-2">
                                <div className="flex items-center gap-2 min-w-0">
                                  <Clock size={13} className="text-accent shrink-0" aria-hidden="true" />
                                  <span className="text-xs text-primary truncate">
                                    {formatRelativeTime(backup.created_at)}
                                  </span>
                                  <span className="text-xs text-accent shrink-0">{formatBytes(backup.size)}</span>
                                </div>
                                <div className="flex items-center gap-1 shrink-0">
                                  <Button
                                    variant="ghost"
                                    size="iconSm"
                                    onClick={() => setRestoreTarget(backup)}
                                    title="Put this copy back"
                                    aria-label="Restore this backup"
                                  >
                                    <RotateCcw size={14} className="text-accent" aria-hidden="true" />
                                  </Button>
                                  <Button
                                    variant="ghost"
                                    size="iconSm"
                                    onClick={() => setDeleteTarget(backup)}
                                    title="Delete this copy"
                                    aria-label="Delete this backup"
                                  >
                                    <Trash2 size={14} className="text-accent" aria-hidden="true" />
                                  </Button>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {backups.some((b) => !apps.find((a) => a.id === b.app_id)) && (
              <div className="px-4 py-3">
                <p className="text-xs text-accent mb-2 flex items-center gap-1.5">
                  <HelpCircle size={13} aria-hidden="true" />
                  Copies from apps that are no longer installed
                </p>
                <ul className="space-y-2">
                  {backups
                    .filter((b) => !apps.find((a) => a.id === b.app_id))
                    .map((backup) => (
                      <li key={backup.id} className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <span className="text-xs font-mono text-primary truncate">{backup.app_id || "Unknown"}</span>
                          <span className="text-xs text-accent shrink-0">
                            {formatRelativeTime(backup.created_at)} · {formatBytes(backup.size)}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          size="iconSm"
                          onClick={() => setDeleteTarget(backup)}
                          title="Delete this copy"
                          aria-label="Delete this backup"
                        >
                          <Trash2 size={14} className="text-accent" aria-hidden="true" />
                        </Button>
                      </li>
                    ))}
                </ul>
              </div>
            )}
          </div>
        </SettingsCard>
      )}

      {!loading && !loadError && stats.totalApps > 0 && (
        <SettingsCard icon={Calendar} title="Whole-system backup" padding={false} index={2}>
          <div className="px-4 py-4">
            <CollapsibleSection
              title="Everything else: settings, accounts, and records"
              pill
              className="bg-primary/5"
            >
              <div className="space-y-3">
                <Callout tone="info" rounded="card">
                  This is a snapshot of LibreServ itself: your settings, user accounts, and the list of what's installed.
                  It doesn't contain your apps' files (those are covered above). Restoring it replaces everything on this device.
                </Callout>
                <div className="flex flex-col sm:flex-row gap-3">
                  <Button
                    variant="primary"
                    onClick={handleSaveDatabase}
                    loading={savingDb}
                    className="flex-1"
                  >
                    {!savingDb && <Download size={16} aria-hidden="true" />}
                    {savingDb ? "Preparing file…" : "Download a system backup"}
                  </Button>
                  <Button
                    variant="outline"
                    surface="secondary"
                    onClick={() => dbFileInputRef.current?.click()}
                    loading={uploadingDb}
                    className="flex-1"
                  >
                    {!uploadingDb && <Upload size={16} aria-hidden="true" />}
                    {uploadingDb ? "Restoring…" : "Restore from a file"}
                  </Button>
                  <input
                    ref={dbFileInputRef}
                    type="file"
                    accept=".gz,.db"
                    className="hidden"
                    onChange={handleDbFileSelect}
                    disabled={uploadingDb}
                  />
                </div>
              </div>
            </CollapsibleSection>
          </div>
        </SettingsCard>
      )}

      {!loading && !loadError && (
        <SettingsCard icon={CloudOff} title="Keep a copy somewhere else" padding={false} index={3}>
          <SettingsRow
            label="Off-site backup storage"
            description="Backups stored only on this device are lost if it breaks, burns, or walks away. Connect cloud storage and copies go there automatically."
            hideDivider
          >
            <Button variant="outline" surface="secondary" size="sm" asChild>
              <a href="#external_services">
                Set up in External Services
                <ArrowRight size={14} aria-hidden="true" />
              </a>
            </Button>
          </SettingsRow>
        </SettingsCard>
      )}

      {scheduleModalApp && (
        <ScheduleForm
          appId={scheduleModalApp.id}
          appName={scheduleModalApp.name}
          existingSchedule={scheduleByApp.get(scheduleModalApp.id) || null}
          onClose={() => setScheduleModalApp(null)}
          onSaved={() => { setScheduleModalApp(null); loadData(); }}
        />
      )}

      <ConfirmModal
        open={!!restoreTarget}
        onClose={() => setRestoreTarget(null)}
        onConfirm={handleRestoreBackup}
        icon={RotateCcw}
        title="Restore this backup?"
        message={restoreTarget ? `This replaces everything ${getAppName(restoreTarget.app_id)} currently knows with how things were ${formatRelativeTime(restoreTarget.created_at)}. The app will restart.` : ""}
        variant="warning"
        confirmLabel="Restore"
        confirmIcon={RotateCcw}
        loading={restoring}
      />

      <ConfirmModal
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDeleteBackup}
        icon={Trash2}
        title="Delete this backup?"
        message={deleteTarget ? `The copy of ${getAppName(deleteTarget.app_id)} from ${formatRelativeTime(deleteTarget.created_at)} will be permanently removed.` : ""}
        variant="danger"
        confirmLabel="Delete"
        confirmIcon={Trash2}
        loading={deleting}
      />

      <ConfirmModal
        open={!!pendingDbFile}
        onClose={() => { setPendingDbFile(null); if (dbFileInputRef.current) dbFileInputRef.current.value = ""; }}
        onConfirm={handleConfirmDbRestore}
        icon={RotateCcw}
        title="Restore the whole system?"
        message={pendingDbFile ? `This replaces every LibreServ setting, account, and record with what's inside "${pendingDbFile.name}". Everything currently here will be overwritten.` : ""}
        variant="danger"
        confirmLabel="Restore everything"
        confirmIcon={RotateCcw}
        loading={uploadingDb}
      />
    </div>
  );
}
