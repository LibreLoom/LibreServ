import { useContext } from "react";
import { ThemeContext } from "../context/ThemeContext.jsx";

export function useTimeFormat() {
  const context = useContext(ThemeContext);
  if (context === undefined) {
    throw new Error("useTimeFormat must be used within a ThemeProvider");
  }
  return {
    use12HourTime: context.use12HourTime,
  };
}