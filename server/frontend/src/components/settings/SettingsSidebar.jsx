import { Settings, Palette, Shield, Info, ChevronRight, DatabaseBackup, Globe, Bell, Plug } from "lucide-react";
import SettingsUserCard from "./SettingsUserCard";
import CardButton from "../cards/CardButton";

const CATEGORIES = [
	{ id: "external_services", label: "External Services", icon: Plug },
	{ id: "general", label: "General", icon: Settings },
	{ id: "appearance", label: "Appearance", icon: Palette },
	{ id: "backups", label: "Backups", icon: DatabaseBackup },
	{ id: "security", label: "Security", icon: Shield },
	{ id: "network", label: "Network", icon: Globe },
	{ id: "notifications", label: "Notifications", icon: Bell },
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
          <CardButton
            id={id}
            onClick={() => onCategoryChange(id)}
            actionLabel={label}
            icon={Icon}
            variant="nav"
            active={isActive}
            align="between"
            ariaCurrent={isActive ? "page" : undefined}
            className="gap-3 px-3 py-2.5"
            trailing={
              <ChevronRight
                size={16}
                className={`shrink-0 transition-transform duration-200 ${
                  isActive ? "translate-x-1" : ""
                }`}
              />
            }
          />
        </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}