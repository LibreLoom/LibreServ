import { useState, useEffect } from "react";
import { useAuth } from "../../hooks/useAuth";
import { goeyToast } from "goey-toast";
import Card from "../common/cards/Card";
import {
  Clock,
  Plus,
  Trash2,
  Edit2,
  Loader2,
  Calendar,
  Save,
  X,
  AlertCircle,
} from "lucide-react";

const SCHEDULE_PRESETS = [
  { label: "Daily at 3 AM", value: "0 3 * * *" },
  { label: "Daily at 2 AM", value: "0 2 * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Weekly on Sunday 3 AM", value: "0 3 * * 0" },
  { label: "Weekly on Saturday 3 AM", value: "0 3 * * 6" },
  { label: "Custom...", value: "custom" },
];

function formatNextRun(cronExpr) {
  if (!cronExpr) return "Not scheduled";
  const parts = cronExpr.split(" ");
  if (parts.length !== 5) return "Invalid schedule";

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;

  if (minute === "0" && hour === "3" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return "Daily at 3:00 AM";
  }
  if (minute === "0" && hour === "2" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*") {
    return "Daily at 2:00 AM";
  }
  if (minute === "0" && hour.startsWith("*/") && dayOfMonth === "*" && month === "*") {
    const interval = hour.replace("*/", "");
    return `Every ${interval} hours`;
  }
  if (dayOfWeek === "0") {
    return "Weekly on Sunday";
  }
  if (dayOfWeek === "6") {
    return "Weekly on Saturday";
  }

  return cronExpr;
}

export default function ScheduleForm() {
  const { request } = useAuth();
  const [schedules, setSchedules] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const [formData, setFormData] = useState({
    app_id: "",
    cron_expr: "0 3 * * *",
    custom_cron: "",
    enabled: true,
    stop_before_backup: false,
    compress: true,
    retention: 7,
  });

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadData() {
    setLoading(true);
    try {
      const [schedulesRes, appsRes] = await Promise.all([
        request("/backups/schedules"),
        request("/apps"),
      ]);

      if (!schedulesRes.ok) throw new Error("Failed to load schedules");
      if (!appsRes.ok) throw new Error("Failed to load apps");

      const schedulesData = await schedulesRes.json();
      const appsData = await appsRes.json();

      setSchedules(schedulesData.schedules || []);
      setApps(appsData.apps || []);
    } catch (err) {
      goeyToast.error("Failed to load schedules", { description: err.message });
    } finally {
      setLoading(false);
    }
  }

  function resetForm() {
    setFormData({
      app_id: "",
      cron_expr: "0 3 * * *",
      custom_cron: "",
      enabled: true,
      stop_before_backup: false,
      compress: true,
      retention: 7,
    });
    setEditingSchedule(null);
    setShowForm(false);
  }

  async function handleSave() {
    if (!formData.app_id) {
      goeyToast.error("Please select an app");
      return;
    }

    const cronExpr = formData.cron_expr === "custom" ? formData.custom_cron : formData.cron_expr;
    if (!cronExpr) {
      goeyToast.error("Please enter a schedule");
      return;
    }

    setSaving(true);
    try {
      const payload = {
        app_id: formData.app_id,
        cron_expr: cronExpr,
        enabled: formData.enabled,
        stop_before_backup: formData.stop_before_backup,
        compress: formData.compress,
        retention: formData.retention,
      };

      let res;
      if (editingSchedule) {
        res = await request(`/backups/schedules/${editingSchedule.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } else {
        res = await request("/backups/schedules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      }

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to save schedule");
      }

      goeyToast.success(editingSchedule ? "Schedule updated" : "Schedule created");
      resetForm();
      loadData();
    } catch (err) {
      goeyToast.error("Failed to save schedule", { description: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(schedule) {
    setDeleting(schedule.id);
    try {
      const res = await request(`/backups/schedules/${schedule.id}`, {
        method: "DELETE",
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to delete schedule");
      }

      goeyToast.success("Schedule deleted");
      loadData();
    } catch (err) {
      goeyToast.error("Failed to delete schedule", { description: err.message });
    } finally {
      setDeleting(null);
    }
  }

  function handleEdit(schedule) {
    setEditingSchedule(schedule);
    setFormData({
      app_id: schedule.app_id || "",
      cron_expr: SCHEDULE_PRESETS.some((p) => p.value === schedule.cron_expr)
        ? schedule.cron_expr
        : "custom",
      custom_cron: SCHEDULE_PRESETS.some((p) => p.value === schedule.cron_expr)
        ? ""
        : schedule.cron_expr,
      enabled: schedule.enabled,
      stop_before_backup: schedule.options?.stop_before_backup || false,
      compress: schedule.options?.compress !== false,
      retention: schedule.retention || 7,
    });
    setShowForm(true);
  }

  function getAppName(appId) {
    const app = apps.find((a) => a.id === appId);
    return app?.name || appId || "All Apps";
  }

  if (loading) {
    return (
      <Card className="p-6">
        <div className="flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-accent" />
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Card className="p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Calendar size={18} className="text-accent" />
            <h2 className="font-mono text-lg text-primary">Backup Schedules</h2>
          </div>
          {!showForm && (
            <button
              onClick={() => setShowForm(true)}
              className="flex items-center gap-1 text-xs text-accent hover:text-secondary transition-colors"
            >
              <Plus size={14} />
              Add Schedule
            </button>
          )}
        </div>

        {schedules.length === 0 && !showForm ? (
          <div className="text-center py-6">
            <Clock className="w-10 h-10 text-primary/30 mx-auto mb-2" />
            <p className="text-sm text-accent">No backup schedules configured</p>
            <button
              onClick={() => setShowForm(true)}
              className="mt-3 inline-flex items-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:ring-2 transition-all font-mono text-sm"
            >
              <Plus size={16} />
              Create Schedule
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {schedules.map((schedule) => (
              <div
                key={schedule.id}
                className="flex items-center justify-between p-3 bg-primary/5 rounded-card"
              >
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-primary">
                      {getAppName(schedule.app_id)}
                    </span>
                    <span
                      className={`px-2 py-0.5 rounded-pill text-xs ${
                        schedule.enabled
                          ? "bg-green-500/20 text-green-500"
                          : "bg-yellow-500/20 text-yellow-500"
                      }`}
                    >
                      {schedule.enabled ? "Active" : "Paused"}
                    </span>
                  </div>
                  <div className="text-xs text-accent mt-1">
                    {formatNextRun(schedule.cron_expr)} · Keep last {schedule.retention} backups
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => handleEdit(schedule)}
                    className="p-1.5 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all"
                    title="Edit"
                  >
                    <Edit2 size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(schedule)}
                    disabled={deleting === schedule.id}
                    className="p-1.5 rounded-pill hover:bg-red-500/10 text-accent/50 hover:text-red-500 transition-all disabled:opacity-50"
                    title="Delete"
                  >
                    {deleting === schedule.id ? (
                      <Loader2 size={14} className="animate-spin" />
                    ) : (
                      <Trash2 size={14} />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {showForm && (
          <div className="mt-4 pt-4 border-t border-primary/10 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-mono text-sm text-primary">
                {editingSchedule ? "Edit Schedule" : "New Schedule"}
              </h3>
              <button
                onClick={resetForm}
                className="p-1 rounded-pill hover:bg-primary/10 text-accent/50 hover:text-accent transition-all"
              >
                <X size={16} />
              </button>
            </div>

            <div>
              <label className="block text-sm font-mono text-primary/70 mb-2">
                Select App
              </label>
              <select
                value={formData.app_id}
                onChange={(e) => setFormData({ ...formData, app_id: e.target.value })}
                className="w-full px-3 py-2 bg-secondary/10 border border-secondary/30 rounded-pill font-mono text-sm text-primary focus-visible:ring-2 focus:ring-accent"
                disabled={!!editingSchedule}
              >
                <option value="">Select an app...</option>
                {apps.map((app) => (
                  <option key={app.id} value={app.id}>
                    {app.name}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-mono text-primary/70 mb-2">
                Schedule
              </label>
              <select
                value={formData.cron_expr}
                onChange={(e) => setFormData({ ...formData, cron_expr: e.target.value })}
                className="w-full px-3 py-2 bg-secondary/10 border border-secondary/30 rounded-pill font-mono text-sm text-primary focus-visible:ring-2 focus:ring-accent"
              >
                {SCHEDULE_PRESETS.map((preset) => (
                  <option key={preset.value} value={preset.value}>
                    {preset.label}
                  </option>
                ))}
              </select>
            </div>

            {formData.cron_expr === "custom" && (
              <div>
                <label className="block text-sm font-mono text-primary/70 mb-2">
                  Cron Expression
                </label>
                <input
                  type="text"
                  value={formData.custom_cron}
                  onChange={(e) => setFormData({ ...formData, custom_cron: e.target.value })}
                  className="w-full px-3 py-2 bg-secondary/10 border border-secondary/30 rounded-pill font-mono text-sm text-primary focus-visible:ring-2 focus:ring-accent"
                  placeholder="0 3 * * * (minute hour day month weekday)"
                />
                <p className="mt-1 text-xs text-primary/50 font-mono">
                  Format: minute hour day-of-month month day-of-week (e.g., "0 3 * * *" for daily at 3 AM)
                </p>
              </div>
            )}

            <div>
              <label className="block text-sm font-mono text-primary/70 mb-2">
                Retention (keep last N backups)
              </label>
              <input
                type="number"
                value={formData.retention}
                onChange={(e) => setFormData({ ...formData, retention: parseInt(e.target.value) || 7 })}
                className="w-full px-3 py-2 bg-secondary/10 border border-secondary/30 rounded-pill font-mono text-sm text-primary focus-visible:ring-2 focus:ring-accent"
                min="1"
                max="365"
              />
            </div>

            <div className="space-y-2">
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData.enabled}
                  onChange={(e) => setFormData({ ...formData, enabled: e.target.checked })}
                  className="w-4 h-4 rounded accent-accent"
                />
                <span className="font-mono text-sm text-primary">Enabled</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData.stop_before_backup}
                  onChange={(e) => setFormData({ ...formData, stop_before_backup: e.target.checked })}
                  className="w-4 h-4 rounded accent-accent"
                />
                <span className="font-mono text-sm text-primary">Stop app before backup (safer)</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={formData.compress}
                  onChange={(e) => setFormData({ ...formData, compress: e.target.checked })}
                  className="w-4 h-4 rounded accent-accent"
                />
                <span className="font-mono text-sm text-primary">Compress backup</span>
              </label>
            </div>

            <div className="flex gap-3">
              <button
                onClick={resetForm}
                className="flex-1 px-4 py-2 rounded-pill bg-primary/10 text-primary hover:bg-primary/20 transition-all font-mono text-sm"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving || !formData.app_id}
                className="flex-1 flex items-center justify-center gap-2 px-4 py-2 rounded-pill bg-accent text-primary hover:ring-2 transition-all font-mono text-sm disabled:opacity-50"
              >
                {saving ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <Save className="w-4 h-4" />
                )}
                {editingSchedule ? "Update" : "Create"}
              </button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
