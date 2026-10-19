import { useEffect } from "react";

import { useTheme } from "@libreloom/ui/hooks/useTheme.jsx";

import { useAuth } from "../../hooks/useAuth";
import { getSecuritySettings } from "../../lib/security-api.js";

// Loads the signed-in user's saved 12-hour time choice so every page uses it,
// not just Settings.
export default function TimeFormatSync() {
  const { me } = useAuth();
  const { setUse12HourTime } = useTheme();
  const userId = me?.id;

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    getSecuritySettings()
      .then((data) => {
        if (!cancelled && typeof data?.use_12_hour_time === "boolean") {
          setUse12HourTime(data.use_12_hour_time);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId, setUse12HourTime]);

  return null;
}
