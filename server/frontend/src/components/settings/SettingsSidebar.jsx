import { Settings, Palette, Shield, Info, ChevronRight, DatabaseBackup } from "lucide-react";
import SettingsUserCard from "./SettingsUserCard";

const CATEGORIES = [
	{ id: "general", label: "General", icon: Settings },
	{ id: "appearance", label: "Appearance", icon: Palette },
	{ id: "backups", label: "Backups", icon: DatabaseBackup },
	{ id: "security", label: "Security", icon: Shield },
	{ id: "about", label: "About", icon: Info },
];

export default function SettingsSidebar({
  user,
  activeCategory,
  onCategoryChange,
  className = "",
}) {
  return (
    <nav
      className={`flex flex-col gap-2 ${className}`}
      aria-label="Settings categories"
    >
      <SettingsUserCard user={user} />

      <div className="mt-4 border-t border-accent/30 pt-4">
        <div className="px-3 mb-3 text-xs font-medium text-secondary uppercase tracking-wider">
          Settings
        </div>
        <ul className="space-y-1 font-bold">
          {CATEGORIES.map(({ id, label, icon: Icon }, index) => {
            const isActive = activeCategory === id;
            return (
<li
          key={id}
          style={{
            animationDelay: `${index * 50}ms`,
          }}
        >
          <button
            onClick={() => onCategoryChange(id)}
            id={id}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-pill transition-all duration-200 ease-out text-left ${
                    isActive
                      ? "bg-secondary text-primary"
                      : "text-secondary hover:bg-secondary/10 hover:text-secondary"
                  }`}
                  aria-current={isActive ? "page" : undefined}
                >
                  <Icon size={18} />
                  <span className="flex-1">{label}</span>
                  <ChevronRight
                    size={16}
                    className={`transition-transform duration-200 ${
                      isActive ? "translate-x-1" : ""
                    }`}
                  />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}