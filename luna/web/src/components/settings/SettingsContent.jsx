import { memo, Suspense } from "react";
import Spinner from "@libreloom/ui/components/ui/Spinner.jsx";
import { CATEGORY_COMPONENTS } from "./categoryComponents.js";

const CATEGORY_TITLES = {
  appearance: "Appearance",
  cloud_backup: "Luna Connect",
  luna_connect: "Luna Connect",
  users: "Users",
  devices: "Devices",
  security: "Security",
  about: "About",
};

/** @param {{ category: string }} props */
function SettingsContent({ category }) {
  const CategoryComponent = CATEGORY_COMPONENTS[category] || CATEGORY_COMPONENTS.appearance;
  const title = CATEGORY_TITLES[category] || "Settings";

  return (
    <div data-slot="settings-content" className="space-y-4">
      <div className="sticky top-0 z-10 surface-primary pt-1 flex items-center justify-between">
        <h1 className="text-2xl font-mono font-normal text-secondary motion-safe:animate-in motion-safe:fade-in duration-150">
          {title}
        </h1>
      </div>
      <Suspense key={category} fallback={<div className="grid min-h-28 place-items-center"><Spinner /></div>}>
        <div className="motion-safe:animate-in motion-safe:fade-in duration-150 pb-16 md:pb-20">
          <CategoryComponent />
        </div>
      </Suspense>
    </div>
  );
}

export default memo(SettingsContent);
