import { useState, useEffect } from "react";
import { useAuth } from "../../hooks/useAuth";
import { useToast } from "../../context/ToastContext";
import FieldLabel from "../common/forms/FieldLabel";
import ModalCard from "../cards/ModalCard";
import Dropdown from "../common/Dropdown";
import CheckboxOptionGroup from "../common/CheckboxOptionGroup";
import Button from "../ui/Button";
import Callout from "../common/Callout";
import { Save } from "lucide-react";

const DAY_OPTIONS = [
  { label: "Sunday", value: "0" },
  { label: "Monday", value: "1" },
  { label: "Tuesday", value: "2" },
  { label: "Wednesday", value: "3" },
  { label: "Thursday", value: "4" },
  { label: "Friday", value: "5" },
  { label: "Saturday", value: "6" },
];

const FREQ_OPTIONS = [
  { label: "Every night", value: "daily" },
  { label: "Once a week", value: "weekly" },
];

const HOUR_OPTIONS = [
  { label: "Midnight", value: "0" },
  { label: "1 AM", value: "1" },
  { label: "2 AM", value: "2" },
  { label: "3 AM", value: "3" },
  { label: "4 AM", value: "4" },
  { label: "5 AM", value: "5" },
];

const KEEP_OPTIONS = [
  { label: "Last 3 copies", value: "3" },
  { label: "Last 7 copies", value: "7" },
  { label: "Last 14 copies", value: "14" },
  { label: "Last 30 copies", value: "30" },
];

function parseCron(cronExpr) {
  const fallback = { freq: "daily", day: "0", hour: "3" };
  if (!cronExpr) return fallback;
  const parts = cronExpr.split(" ");
  if (parts.length !== 5) return fallback;
  const [minute, hour, , , dow] = parts;
  if (hour.startsWith("*/") || isNaN(parseInt(hour))) return fallback;
  const h = parseInt(hour);
  if (dow !== "*") {
    return { freq: "weekly", day: dow, hour: String(h), minute };
  }
  return { freq: "daily", day: "0", hour: String(h), minute };
}

function buildCron(freq, hour, day) {
  if (freq === "weekly") return `0 ${hour} * * ${day}`;
  return `0 ${hour} * * *`;
}

function describe(freq, hour, day) {
  const hourLabel = HOUR_OPTIONS.find((h) => h.value === String(hour))?.label || `${hour}:00`;
  if (freq === "weekly") {
    const dayName = DAY_OPTIONS.find((d) => d.value === String(day))?.label || "Sunday";
    return `Every ${dayName} at ${hourLabel}`;
  }
  return `Every night at ${hourLabel}`;
}

/**
 * Automatic-backup schedule editor. Modal-only: pass the app and (optionally)
 * its existing schedule; calls onSaved after a successful save or delete.
 *
 * @param {{ appId: string, appName?: string, existingSchedule?: object|null, onClose: () => void, onSaved: () => void }} props
 */
export default function ScheduleForm({ appId, appName, existingSchedule = null, onClose, onSaved }) {
  const { request } = useAuth();
  const { addToast } = useToast();
  const editing = !!existingSchedule;

  const parsed = parseCron(existingSchedule?.cron_expr);
  const [freq, setFreq] = useState(parsed.freq);
  const [day, setDay] = useState(parsed.day);
  const [hour, setHour] = useState(parsed.hour);
  const [retention, setRetention] = useState(String(existingSchedule?.retention || 7));
  const [stopBeforeBackup, setStopBeforeBackup] = useState(existingSchedule?.options?.stop_before_backup || false);
  const [enabled, setEnabled] = useState(existingSchedule?.enabled ?? true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!KEEP_OPTIONS.some((o) => o.value === retention)) {
      setRetention("7");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSave() {
    setSaving(true);
    try {
      const payload = {
        app_id: appId,
        cron_expr: buildCron(freq, hour, day),
        enabled,
        stop_before_backup: stopBeforeBackup,
        retention: parseInt(retention) || 7,
      };

      let res;
      if (editing) {
        res = await request(`/backups/schedules/${existingSchedule.id}`, {
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
        throw new Error(err.error || "Failed to save");
      }

      addToast({
        type: "success",
        message: enabled ? "Automatic backups on" : "Schedule saved",
        description: enabled ? `We'll back up ${appName || "this app"} ${describe(freq, hour, day).toLowerCase()}.` : undefined,
      });
      onSaved();
    } catch (err) {
      addToast({ type: "error", message: "Couldn't save automatic backups", description: err.message });
    } finally {
      setSaving(false);
    }
  }

  async function handleTurnOff() {
    if (!editing) return;
    setDeleting(true);
    try {
      const res = await request(`/backups/schedules/${existingSchedule.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to turn off");
      }
      addToast({ type: "success", message: "Automatic backups off", description: `${appName || "This app"} will only be backed up when you tap the button.` });
      onSaved();
    } catch (err) {
      addToast({ type: "error", message: "Couldn't turn off automatic backups", description: err.message });
    } finally {
      setDeleting(false);
    }
  }

  return (
    <ModalCard
      title={editing ? `Automatic backups: ${appName || "app"}` : `Automatic backups: ${appName || "app"}`}
      onClose={onClose}
      footer={
        <div className="flex gap-3 w-full">
          {editing && (
            <Button
              variant="outline"
              surface="secondary"
              onClick={handleTurnOff}
              loading={deleting}
              disabled={saving}
            >
              Turn off
            </Button>
          )}
          <Button
            variant="primary"
            onClick={handleSave}
            loading={saving}
            disabled={deleting}
            className="flex-1"
          >
            {!saving && <Save className="w-4 h-4" aria-hidden="true" />}
            {editing ? "Save changes" : "Turn on"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <Callout tone="neutral" rounded="card">
          LibreServ will save a copy of {appName || "this app"}'s data automatically, so you never have to remember.
          Old copies are cleaned up for you.
        </Callout>

        <div>
          <FieldLabel htmlFor="schedule-freq" surface="secondary">
            How often?
          </FieldLabel>
          <Dropdown
            id="schedule-freq"
            value={freq}
            onChange={setFreq}
            fullWidth
            bg="primary"
            options={FREQ_OPTIONS}
          />
        </div>

        {freq === "weekly" && (
          <div>
            <FieldLabel htmlFor="schedule-day" surface="secondary">
              Which day?
            </FieldLabel>
            <Dropdown
              id="schedule-day"
              value={day}
              onChange={setDay}
              fullWidth
              bg="primary"
              options={DAY_OPTIONS}
            />
          </div>
        )}

        <div>
          <FieldLabel htmlFor="schedule-hour" surface="secondary">
            Around what time?
          </FieldLabel>
          <Dropdown
            id="schedule-hour"
            value={hour}
            onChange={setHour}
            fullWidth
            bg="primary"
            options={HOUR_OPTIONS}
          />
          <p className="text-xs text-accent mt-1.5">
            Pick a time when the device is on and not in heavy use — overnight works best.
          </p>
        </div>

        <div>
          <FieldLabel htmlFor="schedule-retention" surface="secondary">
            How many copies should we keep?
          </FieldLabel>
          <Dropdown
            id="schedule-retention"
            value={retention}
            onChange={setRetention}
            fullWidth
            bg="primary"
            options={KEEP_OPTIONS}
          />
          <p className="text-xs text-accent mt-1.5">
            When a new copy is made, the oldest one is removed. More copies mean more chances to undo, but use more storage.
          </p>
        </div>

        <div className="p-3 bg-primary/5 border border-primary/10 rounded-card">
          <p className="text-xs font-mono text-primary">
            {describe(freq, hour, day)} · keep {retention}
          </p>
        </div>

        <CheckboxOptionGroup
          options={[
            ...(editing ? [{ key: "enabled", label: "Automatic backups enabled" }] : []),
            { key: "stop_before_backup", label: "Pause the app while backing up (a few seconds of downtime, but the safest copy)" },
          ]}
          values={{
            enabled,
            stop_before_backup: stopBeforeBackup,
          }}
          onChange={(key) => {
            if (key === "enabled") setEnabled(!enabled);
            if (key === "stop_before_backup") setStopBeforeBackup(!stopBeforeBackup);
          }}
        />
      </div>
    </ModalCard>
  );
}
