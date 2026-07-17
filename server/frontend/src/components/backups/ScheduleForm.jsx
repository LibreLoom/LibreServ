import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useAuth } from "../../hooks/useAuth";
import { useToast } from "../../context/ToastContext";
import FieldLabel from "../common/forms/FieldLabel";
import Card from "../cards/Card";
import ModalCard from "../cards/ModalCard";
import Dropdown from "../common/Dropdown";
import CheckboxOptionGroup from "../common/CheckboxOptionGroup";
import Button from "../ui/Button";
import {
  Clock,
  Plus,
  Trash2,
  Edit2,
  Loader2,
  Calendar,
  Save,
} from "lucide-react";

const SCHEDULE_PRESETS = [
  { label: "Daily at 3 AM", value: "0 3 * * *" },
  { label: "Daily at 2 AM", value: "0 2 * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Weekly on Sunday 3 AM", value: "0 3 * * 0" },
  { label: "Weekly on Saturday 3 AM", value: "0 3 * * 6" },
  { label: "Custom...", value: "custom" },
];

const CUSTOM_FREQ_OPTIONS = [
  { label: "Daily", value: "daily" },
  { label: "Weekly", value: "weekly" },
  { label: "Every N hours", value: "interval" },
];

const DAY_OPTIONS = [
  { label: "Sunday", value: "0" },
  { label: "Monday", value: "1" },
  { label: "Tuesday", value: "2" },
  { label: "Wednesday", value: "3" },
  { label: "Thursday", value: "4" },
  { label: "Friday", value: "5" },
  { label: "Saturday", value: "6" },
];

const HOUR_OPTIONS = Array.from({ length: 12 }, (_, i) => {
  const h = i === 0 ? 12 : i;
  return { label: String(h), value: String(i) };
});

const MINUTE_OPTIONS = [0, 15, 30, 45].map((m) => ({
  label: String(m).padStart(2, "0"),
  value: String(m),
}));

function buildCron(freq, hour, minute, ampm, day, interval) {
  if (freq === "interval") {
    return `${minute || "0"} */${interval || 6} * * *`;
  }
  let h = parseInt(hour) || 0;
  if (ampm === "pm" && h !== 12) h += 12;
  if (ampm === "am" && h === 12) h = 0;
  if (freq === "weekly") {
    return `${minute || "0"} ${h} * * ${day || "0"}`;
  }
  return `${minute || "0"} ${h} * * *`;
}

function describeCron(freq, hour, minute, ampm, day, interval) {
  const minStr = String(minute || 0).padStart(2, "0");
  if (freq === "interval") {
    return `Every ${interval || 6} hours at :${minStr}`;
  }
  const h = parseInt(hour) || 12;
  const timeStr = `${h}:${minStr} ${ampm || "am"}`.toUpperCase();
  if (freq === "weekly") {
    const dayName = DAY_OPTIONS.find((d) => d.value === (day || "0"))?.label || "Sunday";
    return `${dayName} at ${timeStr}`;
  }
  return `Daily at ${timeStr}`;
}

function formatNextRun(cronExpr) {
  if (!cronExpr) return "Not scheduled";
  const parts = cronExpr.split(" ");
  if (parts.length !== 5) return "Invalid schedule";

  const [, hour, , , dayOfWeek] = parts;
  const [minute] = parts;
  const m = parseInt(minute) || 0;
  const mm = String(m).padStart(2, "0");

  function formatTime(h) {
    if (h === 0) return `12:${mm} AM`;
    if (h === 12) return `12:${mm} PM`;
    return h > 12 ? `${h - 12}:${mm} PM` : `${h}:${mm} AM`;
  }

  if (dayOfWeek === "*" && hour.startsWith("*/")) {
    const interval = hour.replace("*/", "");
    return m > 0 ? `Every ${interval} hours at :${mm}` : `Every ${interval} hours`;
  }
  if (dayOfWeek !== "*") {
    const dayNames = { "0": "Sunday", "1": "Monday", "2": "Tuesday", "3": "Wednesday", "4": "Thursday", "5": "Friday", "6": "Saturday" };
    return `${dayNames[dayOfWeek] || dayOfWeek} at ${formatTime(parseInt(hour))}`;
  }
  return `Daily at ${formatTime(parseInt(hour))}`;
}

function inputClass() {
  return "w-full px-5 py-2 bg-primary border border-primary/20 rounded-pill font-mono text-sm text-secondary focus-visible:ring-2 focus:ring-accent";
}

const INITIAL_FORM = {
  app_id: "",
  cron_expr: "0 3 * * *",
  custom_freq: "daily",
  custom_hour: "3",
  custom_minute: "0",
  custom_ampm: "am",
  custom_day: "0",
  custom_interval: "6",
  enabled: true,
  stop_before_backup: false,
  retention: 7,
};

export default function ScheduleForm() {
  const { request } = useAuth();
  const { addToast } = useToast();
  const [schedules, setSchedules] = useState([]);
  const [apps, setApps] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [showModal, setShowModal] = useState(false);
  const [editingSchedule, setEditingSchedule] = useState(null);
  const [deleting, setDeleting] = useState(null);
  const [formData, setFormData] = useState(INITIAL_FORM);

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
      addToast({ type: "error", message: "Failed to load schedules", description: err.message });
    } finally {
      setLoading(false);
    }
  }

  function closeModal() {
    setFormData(INITIAL_FORM);
    setEditingSchedule(null);
    setShowModal(false);
  }

  async function handleSave() {
    if (!formData.app_id) {
      addToast({ type: "error", message: "Please select an app" });
      return;
    }

    const cronExpr = formData.cron_expr === "custom"
      ? buildCron(formData.custom_freq, formData.custom_hour, formData.custom_minute, formData.custom_ampm, formData.custom_day, formData.custom_interval)
      : formData.cron_expr;
    if (!cronExpr) {
      addToast({ type: "error", message: "Please enter a schedule" });
      return;
    }

    setSaving(true);
    try {
      const payload = {
        app_id: formData.app_id,
        cron_expr: cronExpr,
        enabled: formData.enabled,
        stop_before_backup: formData.stop_before_backup,
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

      addToast({ type: "success", message: editingSchedule ? "Schedule updated" : "Schedule created" });
      closeModal();
      loadData();
    } catch (err) {
      addToast({ type: "error", message: "Failed to save schedule", description: err.message });
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

      addToast({ type: "success", message: "Schedule deleted" });
      loadData();
    } catch (err) {
      addToast({ type: "error", message: "Failed to delete schedule", description: err.message });
    } finally {
      setDeleting(null);
    }
  }

  function handleEdit(schedule) {
    const isPreset = SCHEDULE_PRESETS.some((p) => p.value === schedule.cron_expr);
    let customFreq = "daily";
    let customHour = "3";
    let customMinute = "0";
    let customAmpm = "am";
    let customDay = "0";
    let customInterval = "6";

    if (!isPreset && schedule.cron_expr) {
      const parts = schedule.cron_expr.split(" ");
      const [min, hour, , , dow] = parts;
      customMinute = min;

      if (hour.startsWith("*/")) {
        customFreq = "interval";
        customInterval = hour.replace("*/", "");
      } else {
        const h = parseInt(hour);
        if (dow !== "*") {
          customFreq = "weekly";
          customDay = dow;
        }
        if (h === 0) { customHour = "12"; customAmpm = "am"; }
        else if (h < 12) { customHour = String(h); customAmpm = "am"; }
        else if (h === 12) { customHour = "12"; customAmpm = "pm"; }
        else { customHour = String(h - 12); customAmpm = "pm"; }
      }
    }

    setEditingSchedule(schedule);
    setFormData({
      app_id: schedule.app_id || "",
      cron_expr: isPreset ? schedule.cron_expr : "custom",
      custom_freq: customFreq,
      custom_hour: customHour,
      custom_minute: customMinute,
      custom_ampm: customAmpm,
      custom_day: customDay,
      custom_interval: customInterval,
      enabled: schedule.enabled,
      stop_before_backup: schedule.options?.stop_before_backup || false,
      retention: schedule.retention || 7,
    });
    setShowModal(true);
  }

  function getAppName(appId) {
    const app = apps.find((a) => a.id === appId);
    return app?.name || appId || "All Apps";
  }

  if (loading) {
    return (
      <Card className="p-6" data-slot="schedule-form">
        <div className="flex items-center justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-accent" />
        </div>
      </Card>
    );
  }

  return (
    <>
      <Card
        icon={Calendar}
        padding={false}
        noPopIn
        data-slot="schedule-form"
        headerActions={
          <button
            onClick={() => setShowModal(true)}
            className="flex items-center gap-1 text-xs text-accent hover:text-primary transition-colors"
          >
            <Plus size={14} aria-hidden="true" />
            Add Schedule
          </button>
        }
      >
        {schedules.length === 0 ? (
          <div className="px-4 py-6 text-center">
            <span className="opacity-50 block mb-2"><Clock className="w-10 h-10 text-primary mx-auto" aria-hidden="true" /></span>
            <p className="text-sm text-accent">No backup schedules configured</p>
            <Button
              variant="primary"
              onClick={() => setShowModal(true)}
              className="mt-3"
            >
              <Plus size={16} aria-hidden="true" />
              Create Schedule
            </Button>
          </div>
        ) : (
          <div className="p-4 space-y-3">
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
                      className={cn(
                        "px-2 py-0.5 rounded-pill text-xs",
                        schedule.enabled
                          ? "bg-success/20 text-success"
                          : "bg-warning/20 text-warning",
                      )}
                    >
                      {schedule.enabled ? "Active" : "Paused"}
                    </span>
                  </div>
                  <div className="text-xs text-accent mt-1">
                    {formatNextRun(schedule.cron_expr)} · Keep last {schedule.retention} backups
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="iconSm"
                    onClick={() => handleEdit(schedule)}
                    title="Edit schedule"
                    aria-label="Edit schedule"
                  >
                    <Edit2 size={14} className="text-accent opacity-50" aria-hidden="true" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="iconSm"
                    onClick={() => handleDelete(schedule)}
                    loading={deleting === schedule.id}
                    title="Delete schedule"
                    aria-label="Delete schedule"
                  >
                    <Trash2 size={14} className="text-accent opacity-50" aria-hidden="true" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {showModal && (
        <ModalCard
          title={editingSchedule ? "Edit Schedule" : "New Schedule"}
          onClose={closeModal}
          footer={
            <div className="flex gap-3 w-full">
              <Button
                variant="primary"
                onClick={handleSave}
                loading={saving}
                disabled={!formData.app_id}
                className="flex-1"
              >
                {!saving && <Save className="w-4 h-4" />}
                {editingSchedule ? "Update" : "Create"}
              </Button>
            </div>
          }
        >
          <div className="space-y-4">
            <div>
              <FieldLabel htmlFor="schedule-app" surface="secondary">
                Select App
              </FieldLabel>
              <Dropdown
                id="schedule-app"
                value={formData.app_id}
                onChange={(val) => setFormData({ ...formData, app_id: val })}
                placeholder="Select an app..."
                fullWidth
                disabled={!!editingSchedule}
                surface="primary"
                options={apps.map((app) => ({ value: app.id, label: app.name }))}
              />
            </div>

            <div>
              <FieldLabel htmlFor="schedule-cron" surface="secondary">
                Schedule
              </FieldLabel>
              <Dropdown
                id="schedule-cron"
                value={formData.cron_expr}
                onChange={(val) => setFormData({ ...formData, cron_expr: val })}
                fullWidth
                surface="primary"
                options={SCHEDULE_PRESETS.map((preset) => ({ value: preset.value, label: preset.label }))}
              />
            </div>

            {formData.cron_expr === "custom" && (
              <div className="p-4 bg-primary/5 border border-primary/10 rounded-card space-y-4">
                <div>
                  <FieldLabel surface="secondary">How often?</FieldLabel>
                  <Dropdown
                    value={formData.custom_freq}
                    onChange={(val) => setFormData({ ...formData, custom_freq: val })}
                    fullWidth
                    surface="primary"
                    options={CUSTOM_FREQ_OPTIONS}
                  />
                </div>

                {formData.custom_freq === "interval" ? (
                  <div>
                    <FieldLabel htmlFor="custom-interval" surface="secondary">
                      Run every
                    </FieldLabel>
                    <div className="flex items-center gap-2">
                      <input
                        id="custom-interval"
                        type="number"
                        value={formData.custom_interval}
                        onChange={(e) => setFormData({ ...formData, custom_interval: e.target.value })}
                        className={inputClass() + " w-20"}
                        min="1"
                        max="24"
                      />
                      <span className="text-sm text-accent font-mono">hours</span>
                    </div>
                  </div>
                ) : (
                  <>
                    <div>
                      <FieldLabel surface="secondary">What time?</FieldLabel>
                      <div className="flex items-center gap-2">
                        <Dropdown
                          value={formData.custom_hour}
                          onChange={(val) => setFormData({ ...formData, custom_hour: val })}
                          surface="primary"
                          options={HOUR_OPTIONS}
                        />
                        <span className="text-accent font-mono">:</span>
                        <Dropdown
                          value={formData.custom_minute}
                          onChange={(val) => setFormData({ ...formData, custom_minute: val })}
                          surface="primary"
                          options={MINUTE_OPTIONS}
                        />
                        <Dropdown
                          value={formData.custom_ampm}
                          onChange={(val) => setFormData({ ...formData, custom_ampm: val })}
                          surface="primary"
                          options={[{ label: "AM", value: "am" }, { label: "PM", value: "pm" }]}
                        />
                      </div>
                    </div>

                    {formData.custom_freq === "weekly" && (
                      <div>
                        <FieldLabel surface="secondary">Which day?</FieldLabel>
                        <Dropdown
                          value={formData.custom_day}
                          onChange={(val) => setFormData({ ...formData, custom_day: val })}
                          fullWidth
                          surface="primary"
                          options={DAY_OPTIONS}
                        />
                      </div>
                    )}
                  </>
                )}

                <div className="p-3 bg-secondary text-primary rounded-card">
                  <p className="text-xs font-mono text-accent">
                    {describeCron(formData.custom_freq, formData.custom_hour, formData.custom_minute, formData.custom_ampm, formData.custom_day, formData.custom_interval)}
                  </p>
                </div>
              </div>
            )}

            <div>
              <FieldLabel htmlFor="schedule-retention" surface="secondary">
                Retention (keep last N backups)
              </FieldLabel>
              <input
                id="schedule-retention"
                type="number"
                value={formData.retention}
                onChange={(e) => setFormData({ ...formData, retention: parseInt(e.target.value) || 7 })}
                className={inputClass()}
                min="1"
                max="365"
              />
            </div>

            <CheckboxOptionGroup
              options={[
                ...(editingSchedule ? [{ key: "enabled", label: "Enabled" }] : []),
                { key: "stop_before_backup", label: "Stop app before backup (safer)" },
              ]}
              values={{
                enabled: formData.enabled,
                stop_before_backup: formData.stop_before_backup,
              }}
              onChange={(key) => setFormData({ ...formData, [key]: !formData[key] })}
            />
          </div>
        </ModalCard>
      )}
    </>
  );
}
