import { Palette, Moon, Sun } from "lucide-react";
import SettingsRow from "../SettingsRow";

export default function AppearanceCategory({ darkMode, onDarkModeChange }) {
  return (
    <div className="space-y-4">
      <div className="bg-secondary rounded-large-element overflow-hidden animate-in fade-in slide-in-from-bottom-2 duration-300">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-primary/10">
          <Palette size={18} className="text-accent" />
          <h2 className="font-mono font-normal text-primary">Theme</h2>
        </div>
        <SettingsRow
          label="Dark Mode"
          description="Use dark theme for the interface"
        >
          <button
            onClick={onDarkModeChange}
            className={`relative inline-flex h-7 w-12 items-center rounded-pill transition-all duration-300 ease-out focus:outline-none focus:ring-2 focus:ring-accent focus:ring-offset-2 focus:ring-offset-secondary ${
              darkMode ? "bg-accent" : "bg-primary/20"
            }`}
            role="switch"
            aria-checked={darkMode}
            aria-label="Toggle dark mode"
          >
            <span
              className={`inline-flex items-center justify-center h-5 w-5 rounded-full bg-primary transition-all duration-300 ease-out ${
                darkMode ? "translate-x-6" : "translate-x-1"
              }`}
            >
              {darkMode ? (
                <Moon size={12} className="text-accent" />
              ) : (
                <Sun size={12} className="text-accent" />
              )}
            </span>
          </button>
        </SettingsRow>
      </div>
    </div>
  );
}