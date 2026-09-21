import { cn } from "../../lib/utils.js";
import { ChevronRight, Lock } from "lucide-react";
import Card from "../../components/cards/Card.jsx";
import SettingsUserCard from "./SettingsUserCard.jsx";
import CardButton from "../../components/ui/CardButton.jsx";
import { ICON_SIZE } from "../../lib/ui-tokens.js";

/**
 * Settings category rail: user card on top, category list below.
 *
 * Category lists are product-specific — each app computes its own (e.g.
 * `visibleCategories(isAdmin, connectActive)` from its settingsCategories.js)
 * and passes the result in.
 *
 * @param {{
 *   user: object|null,
 *   categories: { id: string, label: string, icon?: import("react").ComponentType<any> }[],
 *   activeCategory: string,
 *   onCategoryChange: (id: string) => void,
 *   memberHint?: string,
 *   userHref?: string|((user: object) => string|null),
 *   deviceName?: string,
 *   className?: string,
 * }} props
 */
export default function SettingsSidebar({
  user,
  categories,
  activeCategory,
  onCategoryChange,
  memberHint,
  userHref,
  deviceName,
  className = "",
}) {
  const isAdmin = user?.role === "admin";
  return (
    <Card
      as="nav"
      noHeightAnim
      data-slot="settings-sidebar"
      className={cn("flex flex-col gap-2", className)}
      aria-label="Settings categories"
    >
      <SettingsUserCard user={user} href={userHref} deviceName={deviceName} />

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
                      size={ICON_SIZE.md}
                      className={cn("shrink-0 transition-transform duration-200", isActive && "translate-x-1")}
                    />
                  }
                />
              </li>
            );
          })}
        </ul>

        {!isAdmin && memberHint && (
          <p className="px-3 mt-3 flex items-center gap-1.5 text-xs text-primary">
            <Lock size={ICON_SIZE.xs} aria-hidden="true" className="shrink-0" />
            {memberHint}
          </p>
        )}
      </div>
    </Card>
  );
}
