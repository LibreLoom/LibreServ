import { cn } from "@/lib/utils";
import AppearanceCategory from "./categories/AppearanceCategory.jsx";
import NetworkCategory from "./categories/NetworkCategory.jsx";
import RemoteCategory from "./categories/RemoteCategory.jsx";
import CloudBackupCategory from "./categories/CloudBackupCategory.jsx";
import DevicesCategory from "./categories/DevicesCategory.jsx";
import AccessCategory from "./categories/AccessCategory.jsx";
import UpdatesCategory from "./categories/UpdatesCategory.jsx";

const CATEGORY_TITLES = {
  appearance: "Look and feel",
  network: "Home network",
  remote: "Remote access",
  cloud: "Cloud backup",
  devices: "Phones and computers",
  access: "Access",
  updates: "Software updates",
};

const CATEGORY_COMPONENTS = {
  appearance: AppearanceCategory,
  network: NetworkCategory,
  remote: RemoteCategory,
  cloud: CloudBackupCategory,
  devices: DevicesCategory,
  access: AccessCategory,
  updates: UpdatesCategory,
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
