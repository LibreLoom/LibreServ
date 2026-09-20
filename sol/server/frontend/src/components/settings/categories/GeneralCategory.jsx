import { Clock } from "lucide-react";
import Toggle from "../../common/Toggle";
import SettingsCard from "../SettingsCard";
import SystemUpdatesCard from "./SystemUpdatesCard";
import RepoStatusCard from "./RepoStatusCard";

export default function GeneralCategory({ use12HourTime, on12HourTimeChange }) {
  return (
    <div className="space-y-4" data-slot="general-category">
      <SystemUpdatesCard index={0} />

      <RepoStatusCard index={1} />

      <SettingsCard icon={Clock} title="Time" padding={false} index={2}>
        <div className="px-5 py-3">
          <Toggle
            checked={use12HourTime || false}
            onChange={on12HourTimeChange}
            label="12-hour Time"
            description="Show times in 12-hour format (e.g., 2:30 PM instead of 14:30)"
          />
        </div>
      </SettingsCard>
    </div>
  );
}
