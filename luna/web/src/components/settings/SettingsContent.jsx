import { cn } from "@/lib/utils";
import AppearanceCategory from "./categories/AppearanceCategory.jsx";
import NetworkCategory from "./categories/NetworkCategory.jsx";
import ExternalServicesCategory from "./categories/ExternalServicesCategory.jsx";
import DevicesCategory from "./categories/DevicesCategory.jsx";
import AccessCategory from "./categories/AccessCategory.jsx";
import AboutCategory from "./categories/AboutCategory.jsx";

const CATEGORY_TITLES = {
  appearance: "Appearance",
  network: "Local Network",
  external_services: "External Services",
  devices: "Devices",
  security: "Security",
  about: "About",
};

const CATEGORY_COMPONENTS = {
  appearance: AppearanceCategory,
  network: NetworkCategory,
  external_services: ExternalServicesCategory,
  devices: DevicesCategory,
  security: AccessCategory,
  about: AboutCategory,
};

export default function SettingsContent({ category }) {
  const CategoryComponent = CATEGORY_COMPONENTS[category] || AppearanceCategory;
  const title = CATEGORY_TITLES[category] || "Settings";

  return (
    <div data-slot="settings-content" className={cn("space-y-4")}>
      <div className={cn("sticky top-0 z-10 bg-primary text-secondary pt-1 flex items-center justify-between")}>
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
