import { FileText, Clock } from "lucide-react";
import ValueDisplay from "../../common/ValueDisplay";
import Dropdown from "../../common/Dropdown";
import Toggle from "../../common/Toggle";
import SettingsCard from "../SettingsCard";
import FactoryResetCard from "./FactoryResetCard";
import SystemUpdatesCard from "./SystemUpdatesCard";

export default function GeneralCategory({ settings, use12HourTime, on12HourTimeChange }) {
  return (
    <div className="space-y-4">
      <SystemUpdatesCard index={0} />

      <SettingsCard icon={Clock} title="Time" padding={false} index={1}>
        <div className="px-5 py-3">
          <Toggle
            checked={use12HourTime || false}
            onChange={on12HourTimeChange}
            label="12-hour Time"
            description="Show times in 12-hour format (e.g., 2:30 PM instead of 14:30)"
          />
        </div>
      </SettingsCard>

      <SettingsCard icon={FileText} title="Logging" padding={false} index={2}>
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-primary">Log Level</div>
              <div className="text-sm text-accent mt-0.5">Verbosity of logged messages</div>
            </div>
            <Dropdown
              value={settings?.logging?.level || "info"}
              onChange={(val) => settings?.onLoggingChange?.(val)}
              width={120}
              options={[
                { value: "debug", label: "Debug" },
                { value: "info", label: "Info" },
                { value: "warn", label: "Warn" },
                { value: "error", label: "Error" },
              ]}
            />
          </div>
          <ValueDisplay label="Log Path" value={settings?.logging?.path || "N/A"} />
        </div>
      </SettingsCard>

      <FactoryResetCard settings={settings} index={3} />
    </div>
  );
}
