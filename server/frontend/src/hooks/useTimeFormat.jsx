import { useContext, useCallback } from "react";
import { ThemeContext } from "../context/ThemeContext.jsx";
import { formatTime, formatDateWithTime, formatDateLong } from "../lib/time-utils.js";

export function useTimeFormat() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTimeFormat must be used within a ThemeProvider");
  }

  const use12Hour = !!context.use12HourTime;

  const formatTimeString = useCallback(
    (date) => formatTime(date, use12Hour),
    [use12Hour],
  );

  const formatDateTime = useCallback(
    (dateInput) => formatDateWithTime(dateInput, use12Hour),
    [use12Hour],
  );

  const formatDateLongWithTime = useCallback(
    (dateInput) => formatDateLong(dateInput, use12Hour),
    [use12Hour],
  );

  return {
    use12HourTime: use12Hour,
    formatTime: formatTimeString,
    formatDateTime,
    formatDateLong: formatDateLongWithTime,
  };
}
