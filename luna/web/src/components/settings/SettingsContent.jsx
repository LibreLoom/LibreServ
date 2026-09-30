import { cn } from "@libreloom/ui/lib/utils.js";
import AppearanceCategory from "./categories/AppearanceCategory.jsx";
import { CATEGORY_COMPONENTS } from "./categoryComponents.js";

const CATEGORY_TITLES = {
  appearance: "Appearance",
  external_services: "External Services",
  devices: "Devices",
  security: "Security",
  about: "About",
};

export default function SettingsContent({ category }) {
  const CategoryComponent = CATEGORY_COMPONENTS[category] || AppearanceCategory;
  const title = CATEGORY_TITLES[category] || "Settings";

  return (
    <div data-slot="settings-content" className={cn("space-y-4")}>
      <div className={cn("sticky top-0 z-10 surface-primary pt-1 flex items-center justify-between")}>
        <h1 className={cn("text-2xl font-mono font-normal text-secondary animate-in fade-in slide-in-from-bottom-1 duration-150")}>
          {title}
        </h1>
      </div>
      <div key={category} className={cn("animate-in fade-in duration-150 pb-16 md:pb-20")}>
        <CategoryComponent />
      </div>
    </div>
  );
}
