import { cn } from "@/lib/utils";
import { ChevronRight, Lock } from "lucide-react";
import Card from "../cards/Card";
import SettingsUserCard from "./SettingsUserCard";
import CardButton from "../ui/CardButton";
import { visibleCategories } from "./settingsCategories";

export default function SettingsSidebar({
  user,
  activeCategory,
  onCategoryChange,
  className = "",
}) {
  const isAdmin = user?.role === "admin";
  const categories = visibleCategories(isAdmin);
  return (
    <Card
      as="nav"
      noHeightAnim
      data-slot="settings-sidebar"
      className={cn("flex flex-col gap-2", className)}
      aria-label="Settings categories"
    >
      <SettingsUserCard user={user} />

      <div className="mt-4 border-t border-primary/10 pt-4">
        <div className="px-3 mb-3 text-xs font-medium text-primary uppercase tracking-wider">
          Settings
        </div>
        <ul className="space-y-1 font-bold">
          {categories.map(({ id, label, icon: Icon }, index) => {
            const isActive = activeCategory === id;
            return (
              <li
                key={id}
                className="animate-nav-slide-in"
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
                      className={cn("shrink-0 transition-transform duration-200", isActive && "translate-x-1")}
                    />
                  }
                />
              </li>
            );
          })}
        </ul>

        {!isAdmin && (
          <p className="px-3 mt-3 flex items-center gap-1.5 text-xs text-primary">
            <Lock size={12} aria-hidden="true" className="shrink-0" />
            Some settings require an administrator.
          </p>
        )}
      </div>
    </Card>
  );
}
