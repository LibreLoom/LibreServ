import { cn } from "@/lib/utils";
import AppearanceCategory from "./categories/AppearanceCategory.jsx";
import NetworkCategory from "./categories/NetworkCategory.jsx";
import RemoteCategory from "./categories/RemoteCategory.jsx";
import CloudBackupCategory from "./categories/CloudBackupCategory.jsx";
import DevicesCategory from "./categories/DevicesCategory.jsx";
import AppsCategory from "./categories/AppsCategory.jsx";
import PasswordCategory from "./categories/PasswordCategory.jsx";
import SignedInCategory from "./categories/SignedInCategory.jsx";
import UpdatesCategory from "./categories/UpdatesCategory.jsx";

const CATEGORY_TITLES = {
  appearance: "Look and feel",
  network: "Home network",
  remote: "Remote access",
  cloud: "Cloud backup",
  devices: "Phones and computers",
  apps: "Apps and access tokens",
  password: "If you forget your password",
  signed_in: "Who is signed in",
  updates: "Software updates",
};

const CATEGORY_COMPONENTS = {
  appearance: AppearanceCategory,
  network: NetworkCategory,
  remote: RemoteCategory,
  cloud: CloudBackupCategory,
  devices: DevicesCategory,
  apps: AppsCategory,
  password: PasswordCategory,
  signed_in: SignedInCategory,
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
